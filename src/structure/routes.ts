/**
 * Structure rules for one nest (docs/prds/structure-rules.md §6): which
 * folders may exist, what goes in them, how files are named and which
 * template they start from. Each nest keeps its own rules in its own vault
 * (`.context/config.yaml`), so they travel with a bundle export and bind MCP
 * and `ctx` writes too. Every rule is the engine's: these routes only read,
 * save and check them — nothing here parses or matches a rule.
 *
 *   GET  /nests/:id/structure?folder=&report=1   read tier
 *   PUT  /nests/:id/structure                    owner or admin
 *   POST /nests/:id/structure/check              read tier; owner or admin with `rules`
 */
import { Hono } from "hono";
import yaml from "js-yaml";
import {
  checkDocument,
  checkFolder,
  compileStructure,
  ContextNestError,
  describeStructure,
  scaffoldPlan,
  setStructure,
  structureReport,
  type CompiledStructure,
  type StructureConfig,
} from "@promptowl/contextnest-engine";
import type { AuthEnv } from "../auth/middleware.js";
import { ForbiddenError, ValidationError } from "../shared/errors.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { canManageStewards } from "../governance/stewardship-service.js";
import { engineApi, opContext } from "../nodes/engine.js";
import { ACCEPTED_NODE_TYPES, derivedNodeId, folderToSegments } from "../nodes/service.js";

export const structureRoutes = new Hono<AuthEnv>();

/** Most titles or folders one check may judge. */
const MAX_CHECKS = 50;

/** The three config blocks the rules live in; every other key is the vault's own. */
function rulesOf(body: unknown): StructureConfig {
  const b = (body ?? {}) as Record<string, unknown>;
  const rules: Record<string, unknown> = {};
  for (const key of ["structure", "folders", "templates"] as const) {
    if (b[key] !== undefined && b[key] !== null) rules[key] = b[key];
  }
  return rules as StructureConfig;
}

/** `folders.x.types: unknown node type…` → { "folders.x.types": "unknown node type…" }. */
function fieldError(message: string): Record<string, string> {
  const at = message.indexOf(": ");
  return at > 0 ? { [message.slice(0, at)]: message.slice(at + 2) } : { _: message };
}

/** Compile, or the engine's reason as a field error. */
function compile(rules: StructureConfig): { rules: CompiledStructure } | { fieldErrors: Record<string, string>; error: string } {
  try {
    return { rules: compileStructure(rules) };
  } catch (err) {
    if (err instanceof ContextNestError && err.code === "CONFIG_ERROR") {
      return { fieldErrors: fieldError(err.message), error: err.message };
    }
    throw err;
  }
}

async function context(c: { get: (k: "userId") => string }, nestId: string) {
  return opContext(nestId, (await resolveCallerEmail(c.get("userId"))) ?? "anonymous");
}

/** Owners and admins manage a nest's rules — never a key scoped to the nest. */
async function assertCanManage(c: any, nestId: string): Promise<void> {
  if (c.get("nestScope")) throw new ForbiddenError("A nest-scoped API key cannot change structure rules.");
  if (!(await canManageStewards(nestId, c.get("userId")))) {
    throw new ForbiddenError("Only the nest's owners and admins can change its structure rules.");
  }
}

/** The saved rule blocks as YAML, for the read-only "View YAML" panel. */
function asYaml(rules: StructureConfig): string {
  return Object.keys(rules).length === 0 ? "" : yaml.dump(rules, { lineWidth: -1, noRefs: true });
}

structureRoutes.get("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  const ctx = await context(c, nestId);
  const folder = c.req.query("folder");
  const out = await engineApi.run<Record<string, unknown>>(
    "context_structure",
    { ...(folder !== undefined ? { folder } : {}), ...(c.req.query("report") ? { report: true } : {}) },
    ctx,
  );
  const saved = rulesOf(await ctx.storage.readConfig());
  // `rules` is what the editor starts from — the saved blocks as written, so
  // a save sends back the owner's own spellings; `types` are the node types
  // this server accepts, for the editor's checkboxes.
  return c.json({ ...out, rules: saved, yaml: asYaml(saved), types: [...ACCEPTED_NODE_TYPES] });
});

structureRoutes.put("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  await assertCanManage(c, nestId);
  const rules = rulesOf(await c.req.json().catch(() => ({})));
  const compiled = compile(rules);
  if ("error" in compiled) return c.json({ error: compiled.error, fieldErrors: compiled.fieldErrors }, 400);
  const ctx = await context(c, nestId);
  if (!(await ctx.storage.readConfig())) {
    throw new ValidationError("This nest has no settings file to keep rules in yet. Re-import or recreate the nest, then try again.");
  }
  await setStructure(ctx.storage, rules);
  const violations = await structureReport(ctx.storage, compiled.rules);
  return c.json({ ...describeStructure(compiled.rules), violations: violations.length });
});

interface CheckTest {
  folder?: string;
  title?: string;
  name?: string;
  type?: string;
  body?: string;
  /** Try the name against this file-name format alone (the editor's "Try a title"). */
  file_name?: string;
  /** Try the name against this folder-name format alone ("Try a folder name"). */
  folder_name?: string;
}

interface CheckBody {
  rules?: unknown;
  report?: boolean;
  tests?: CheckTest[];
  folders?: string[];
}

/**
 * A name judged against one format, by the engine: a one-rule set holding
 * just that format, so the verdict does not depend on finding a folder the
 * rest of the rules would accept.
 */
function tryFormat(t: CheckTest) {
  const folderFormat = t.folder_name !== undefined;
  const format = String((folderFormat ? t.folder_name : t.file_name) ?? "").trim();
  const slug = derivedNodeId(String(t.name ?? t.title ?? ""))?.split("/").pop() ?? "";
  if (!format || !slug) return { ok: true, slug, violations: [] };
  const compiled = compile({ folders: folderFormat ? { "try/{name}": { folder_name: format } } : { try: { file_name: format } } });
  if ("error" in compiled) {
    return { ok: false, slug, violations: [{ code: "CONFIG_ERROR", path: slug, message: Object.values(compiled.fieldErrors)[0] }] };
  }
  const violations = folderFormat
    ? checkFolder(compiled.rules, `try/${slug}`)
    : checkDocument(compiled.rules, { id: `nodes/try/${slug}`, type: "document" }).filter((v) => v.code === "FILE_NAME");
  const what = folderFormat ? "Folder names" : "File names";
  return {
    ok: violations.length === 0,
    slug,
    violations: violations.map((v) => ({ ...v, path: slug, message: `${what} here must look like ${format}; "${slug}" does not.` })),
  };
}

structureRoutes.post("/check", async (c) => {
  const nestId = c.req.param("nestId")!;
  const body = (await c.req.json().catch(() => ({}))) as CheckBody;
  const tests = body.tests ?? [];
  const folders = body.folders ?? [];
  if (!Array.isArray(tests) || !Array.isArray(folders)) throw new ValidationError("tests and folders must be lists");
  if (tests.length > MAX_CHECKS || folders.length > MAX_CHECKS) {
    throw new ValidationError(`A check judges at most ${MAX_CHECKS} titles and ${MAX_CHECKS} folders.`);
  }
  const ctx = await context(c, nestId);

  // A draft is judged only for the people who could save it.
  let draft: StructureConfig;
  if (body.rules !== undefined) {
    await assertCanManage(c, nestId);
    draft = rulesOf(body.rules);
  } else {
    draft = rulesOf(await ctx.storage.readConfig());
  }
  const compiled = compile(draft);
  if ("error" in compiled) {
    return c.json({ fieldErrors: compiled.fieldErrors, error: compiled.error, warnings: [], results: [], folders: [] });
  }
  const rules = compiled.rules;

  const results = tests.map((t) => {
    if (t.file_name !== undefined || t.folder_name !== undefined) return tryFormat(t);
    let id: string | null;
    try {
      id = derivedNodeId(String(t.name ?? t.title ?? ""), String(t.folder ?? ""));
    } catch (err) {
      return { ok: false, slug: "", violations: [{ code: "FOLDER_NAME", path: String(t.folder ?? ""), message: (err as Error).message }] };
    }
    if (!id) return { ok: true, slug: "", violations: [] };
    // Sections are judged only on a body the caller sends: a title check has none yet.
    const violations = checkDocument(rules, { id, type: t.type ?? "document", body: t.body ?? "" }).filter(
      (v) => t.body !== undefined || v.code !== "MISSING_SECTION",
    );
    return { ok: violations.length === 0, slug: id.split("/").pop()!, violations };
  });

  const folderResults = folders.map((raw) => {
    let folder: string;
    try {
      folder = folderToSegments(String(raw)).join("/");
    } catch (err) {
      return { folder: String(raw), violations: [{ code: "FOLDER_NAME", path: String(raw), message: (err as Error).message }], creates: { folders: [], files: [] } };
    }
    const plan = scaffoldPlan(rules, [folder]);
    return {
      folder,
      violations: checkFolder(rules, folder),
      creates: { folders: plan.folders, files: plan.documents.map((d) => ({ path: d.path })) },
    };
  });

  return c.json({
    fieldErrors: {},
    warnings: describeStructure(rules).warnings ?? [],
    results,
    folders: folderResults,
    ...(body.report === true ? { report: { violations: await structureReport(ctx.storage, rules) } } : {}),
  });
});
