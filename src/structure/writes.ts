/**
 * Structure rules on the writes Community makes without an engine operation —
 * moving a document, creating an empty folder, deleting a folder, asking to
 * delete — and the engine's refusals worded for people. Every judgement is
 * the engine's own (its exported checkers); nothing here reads a rule.
 */
import {
  assertStructureDelete,
  checkDeleteDocument,
  checkDeleteFolder,
  checkDocument,
  checkFolder,
  enforceStructure,
  enforcedStructure,
  missingFolders,
  scaffoldFolders,
  type CompiledStructure,
  type NestStorage,
} from "@promptowl/contextnest-engine";
import { ValidationError } from "../shared/errors.js";

/** What the engine adds for agents; people get the page that shows the rules. */
const AGENT_TAIL = " See `ctx structure` (context_structure) for this nest's rules.";

export function forPeople(message: string): string {
  return message.endsWith(AGENT_TAIL)
    ? `${message.slice(0, -AGENT_TAIL.length)} See this nest's Structure page for its rules.`
    : message;
}

/** The engine refusing a write as invalid (a structure rule, a reserved path) — a 400 the caller can act on. */
export function ruleRefusal(err: unknown): ValidationError | null {
  const e = err as { code?: string; message?: string } | null;
  return e?.code === "VALIDATION_FAILED" ? new ValidationError(forPeople(e.message ?? "")) : null;
}

/** Engine refusals keep their meaning, worded for people. */
async function judged<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw ruleRefusal(err) ?? err;
  }
}

/**
 * Moving `from` to `to` is a delete there and a create here: a required file
 * may not leave its folder, and the document must fit where it lands. Returns
 * the folders the move creates, to scaffold once it is written.
 */
export async function assertMovable(
  storage: NestStorage,
  from: string,
  to: string,
  node: { frontmatter: { type?: string; status?: string }; body: string },
): Promise<{ rules: CompiledStructure; created: { root: string; folders: string[] } } | null> {
  const rules = await enforcedStructure(storage);
  if (!rules) return null;
  await judged(() => assertStructureDelete(storage, from));
  await judged(() =>
    enforceStructure(rules, checkDocument(rules, { id: to, type: node.frontmatter.type, body: node.body, status: node.frontmatter.status })),
  );
  return { rules, created: await missingFolders(storage, to) };
}

/**
 * A new empty folder must be one the rules allow, named as they say. `vaultPath`
 * is the folder as the vault holds it (with its root, e.g. `nodes/…`);
 * `folder` is content-relative. Returns what to scaffold once it exists.
 */
export async function assertFolderCreatable(
  storage: NestStorage,
  folder: string,
  vaultPath: string,
): Promise<{ rules: CompiledStructure; created: { root: string; folders: string[] } } | null> {
  const rules = await enforcedStructure(storage);
  if (!rules) return null;
  await judged(() => enforceStructure(rules, checkFolder(rules, folder)));
  return { rules, created: await missingFolders(storage, `${vaultPath}/_`) };
}

/** Create a folder's required subfolders and files (drafts from their templates). Best effort. */
export async function scaffold(storage: NestStorage, plan: Awaited<ReturnType<typeof assertMovable>>): Promise<void> {
  if (!plan) return;
  try {
    await scaffoldFolders(storage, plan.rules, plan.created);
  } catch (err) {
    console.error("structure scaffold:", err);
  }
}

/**
 * A required folder cannot be deleted alone. Returns the order to delete the
 * documents under it in: deepest first, and in each folder its required files
 * last — so the engine's required-file guard holds as the folder empties
 * rather than refusing halfway through.
 */
export async function folderDeleteOrder(storage: NestStorage, folder: string, ids: string[]): Promise<string[]> {
  const rules = await enforcedStructure(storage);
  if (!rules) return ids;
  await judged(() => enforceStructure(rules, checkDeleteFolder(rules, folder)));
  const required = (id: string) => (checkDeleteDocument(rules, id, 1).length > 0 ? 1 : 0);
  const depth = (id: string) => id.split("/").length;
  return [...ids].sort((a, b) => depth(b) - depth(a) || required(a) - required(b));
}

/** Refused at the request, not later at approval: a required file, or a required folder alone. */
export async function assertDeletionRequestable(
  storage: NestStorage,
  targetType: string,
  target: string,
): Promise<void> {
  if (targetType === "document") await judged(() => assertStructureDelete(storage, target));
  if (targetType === "folder") {
    const rules = await enforcedStructure(storage);
    if (rules) await judged(() => enforceStructure(rules, checkDeleteFolder(rules, target)));
  }
}
