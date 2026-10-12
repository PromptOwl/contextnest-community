# PRD: Structure Rules — Governed Folder Layout, Naming, and Templates

**Status:** Proposed · **Date:** 2026-10-07 · **Owner:** Qaish
**Governing rules:** Engine Logic Boundary · Engine & CLI Sync Discipline (see `CLAUDE.md`)

## 1. Problem

A nest has no shape of its own. Any editor, agent or `ctx` call can create any folder, give a file any name, and put any node type anywhere. Over time a governed knowledge base drifts into an ad-hoc dump: `notes/`, `misc/`, `new-folder-2/`, meeting notes with and without dates, PDFs mixed in with prose.

Owners need **hard rules** for:

- **Structure.** Which folders and subfolders may exist, including subfolders that must always exist.
- **Naming.** Formats for folder names and file names, as simple tokens (date, year, number) or as regex.
- **Placement.** Which kinds of files (node types) may be added in which folder.
- **Templates.** Starting content for the files in a folder, sections that must not be removed, and files that must exist in every matching folder.

These rules must be visible to everyone who writes:

- the Community UI;
- agents on MCP;
- the `ctx` CLI;
- the coding-agent plugin, which shells out to `ctx`.

Today nothing enforces any of this:

- The engine's `.context/config.yaml` already declares `folders.<name>.template`, but no code reads it (`ContextNest/packages/engine/src/schemas.ts:384`).
- Spec §1.8 naming conventions are advisory.
- Community's only placement control is the server-wide `ACCEPTED_NODE_TYPES` set (`src/nodes/service.ts:409`).

## 2. Goals / Non-Goals

**Goals**

1. Per-nest structure rules: folder patterns, allowed node types, folder- and file-name formats (tokens or regex), templates, required sections, and required subfolders and files.
2. **One definition, enforced identically everywhere.** The engine holds the rules and the checker. The UI, REST, MCP, `ctx` and the plugin all see the same rules and get the same refusals.
3. **Safe rollout.** Rules start report-only, existing content is grandfathered, and switching enforcement on never breaks what is already there.
4. A clear, form-based UI for owners. Nobody hand-edits YAML.

**Non-Goals**

- **Auto-naming or renaming.** Naming is **validate-only**: the server never changes a name the caller gave.
- A rename operation. That is a separate follow-up; see §12.
- Per-role bypass of the rules, or review-gated rule changes.
- Any engine logic in the UI. The UI calls APIs for every check.

## 3. The rules

### 3.1 Where they live

The rules live in the nest's vault, in **`.context/config.yaml`**. This extends the `folders` key the spec already defines (§11.1) and adds two new keys.

Why the vault and not a Community DB column:

- The rules **travel with the vault**: the export bundle already allowlists `.context/config.yaml`, and `ctx` sees them locally.
- **One engine checker** serves every surface.
- It follows the precedent of the `review` gate: a config-declared rule that the write surfaces apply.

```yaml
structure:
  enforce: true     # false (default) = report-only; true = refuse writes that break the rules
  closed: true      # true = docs only in declared folders; folders only where a pattern allows

folders:            # existing spec key — keys may now be path PATTERNS (plain names still valid)
  "clients/{client}":
    folder_name: "/[a-z]+-[0-9]{3}/"            # how {client} must look: token pattern or /regex/
    types: [document]
    files:                                       # required files, scaffolded from templates
      overview: { template: client-overview }
  "clients/{client}/meetings":
    required: true                               # required subfolder, scaffolded with its parent
    types: [document]
    file_name: "{date}-{slug}"
    template: meeting-note
  "clients/{client}/contracts": { required: true, types: [pdf] }
  decisions:        { types: [document], file_name: "/adr-[0-9]{4}-[a-z0-9-]+/", template: adr }
  "reports/{yyyy}": { file_name: "{date}-{slug}" }

templates:
  meeting-note:
    body: |
      ## Attendees
      ## Agenda
      ## Decisions
      ## Action items
    required_sections: [Decisions, Action items]
  client-overview:
    body: "## Summary\n## Contacts\n## Engagements\n"
```

Existing configs stay valid. A `folders:` entry that has only `description` and `template` is a literal pattern with no constraints; a `template` that names nothing under `templates` is a label (no body, no required sections), and folder keys are matched literally, so a vault's own names (`Engineering`, `my notes`) work. Only `structure.enforce: true` changes what a write does.

### 3.2 Paths and patterns

- **The path being checked.** It is the document id with an optional leading `nodes/` removed. This is the same rule Community's `folderToSegments` applies, and it does not depend on whether the vault uses the structured or the Obsidian layout.
- **Exempt paths — only at the vault root.** `packs/` and `_suggestions/` (their own files), the vault's own `CONTEXT.md`, and `sources/` for `type: source` nodes. Their look-alikes (`nodes/packs/`, `nodes/context`, dot-folders, an `INDEX` id) are ordinary paths: exempting them let any writer get around closed mode. An id is never extension-stripped. In a structured vault only `nodes/` holds content folders, so root-level folders such as `assets/` are not judged.
- **Reserved paths — never writable as documents,** rules or not: any `.context`, `.versions` or `_suggestions` segment (any depth, case-insensitive, Windows trailing dots and spaces ignored), a root `packs/`, or a `\` in the id (a separator on Windows, a file-name character elsewhere). Every engine write path calls `assertWritableDocumentId` (`context_import` `files[]` included, for document files); in a flat vault, exempting root `packs/`/`_suggestions/` without this let documents be created there and discovered as nodes. Community's own write paths must call it too: `moveNode` on the destination id, and `createEmptyFolder` on the folder path. Literal keys that differ only in case are one pattern declared twice and refused.
- **Segments.** A pattern segment is either a literal (`meetings`) or a placeholder (`{label}`).
- **Precedence.** When several patterns match, they are compared segment by segment, and at the first difference a literal beats a placeholder. Declaration order is not used, because JavaScript objects list integer-like keys (`"2024"`) first.
- **Ancestors.** Ancestors of a declared pattern are allowed as folders. `clients/{client}/meetings` implies `clients` and `clients/{client}`. An ancestor holds documents only if it is declared itself.
- **Defaults.** No `types` means any accepted type. No `file_name` means any name.
- **`closed`.**
  - When off (the default), rules apply only where a pattern matches, and everything else is free. A placeholder still constrains every folder at its position — `{yyyy}` at the root makes every root folder a year — unless a more specific pattern (a literal) matches it.
  - When on, a document or folder that matches no pattern (and is not an implied ancestor) is a violation.

### 3.3 Name formats

`folder_name` constrains a rule's trailing placeholder segment. `file_name` constrains the names of the files directly in that folder. Both take one of two forms.

**Token patterns** mix literal text with these tokens:

| Token | Matches |
|---|---|
| `{slug}` | kebab-case, `[a-z0-9]+(-[a-z0-9]+)*` |
| `{date}` | `YYYY-MM-DD` |
| `{yyyy}` | a four-digit year |
| `{n}` | one or more digits |

- A file-name pattern may contain at most one `{slug}`. Two would make the match ambiguous.
- A placeholder whose label is a token (`reports/{yyyy}`) needs no `folder_name`. Any other label (`{client}`) defaults to `{slug}`; the label is what the UI shows ("New client").

**Regex** is any value written as `/…/`.

- It is **implicitly anchored** (`^(?:…)$`) and takes no flags.
- It is matched against the name **exactly as it appears in the id** (folder segment, or the file's last segment). Ids that Community and the engine derive from titles and folder names are lowercase kebab-case, so the UI says so wherever a regex is entered; literal folder names in rules compare case-insensitively.
- **Safety: a whitelist grammar, and never the backtracking engine.** Rules are written by nest owners on a shared server, so a regex must not be able to stall the process. Four review rounds broke every attempt to bound JavaScript's backtracking by banning constructs: a blocklist, then quantifier and alternation budgets that 256 distinct rules multiplied back into seconds. So an owner regex never runs on `RegExp`. It must stay inside this grammar; anything else is refused with `CONFIG_ERROR` naming the key:
  - literals, the escapes `\d \w \s \D \W \S` and escaped punctuation, `[classes]` (parsed the way JavaScript parses them), `.`, `^` and `$`;
  - quantifiers `* + ? {m} {m,} {m,n}` on single atoms only, with bounds of at most 3 digits;
  - literal `{ } [ ]` must be escaped;
  - `( )` / `(?: )` groups with `|` alternatives, never quantified;
  - at most 200 characters.

  The engine parses it into a small AST and matches by carrying the set of reachable positions through each item. Because no group repeats, each item is one pass over the name, so a match costs O(items × length) whatever the pattern's shape. There is no quantifier or alternation budget. A differential test checks that the matcher agrees with `RegExp` on accepted patterns. A name longer than 128 characters is refused without running the pattern. Spec §11.1.1 states the exact grammar and requires linear-time matching from other implementations.
- **Per-check cost.** A vault declares at most 256 folder rules, and each (format, name) result is memoized within a check. 256 distinct worst-case rules meeting one name take milliseconds. Token patterns compile to unambiguous expressions and keep their own limits: at most 3 variable-width tokens (`{slug}`, `{n}`), never two side by side.

**File names are checked on the id's leaf, not the title.**

- The leaf is `slugify(title)` unless the caller passes an explicit id.
- A title with no ASCII letters or digits gets a generated slug that can never match a name rule. The refusal message says so.
- Leaves listed under the folder's `files:` are always allowed, whatever `file_name` says.

### 3.4 Templates, required sections, required files and subfolders

- **Templates.** `folders.<pattern>.template` names an entry in `templates:`. A name that matches no entry is a label (no body, no sections) and `context_structure` returns it under `warnings` — a typo would otherwise enforce nothing, silently.
  - Every surface offers the template body as the starting content of a new file in that folder: the UI editor, `ctx structure --folder`, and `context_structure`.
  - The engine does **not** silently fill empty content, except when it scaffolds a required file.
- **Required sections.** `templates.<name>.required_sections` lists headings (any level) that a document in that folder must contain. A heading satisfies a section when their §4 anchors match (the anchors `#section` links use: a-z, 0-9, `-`). A section whose anchor is empty (non-ASCII text such as `背景`) or that shares an anchor with another (`C++ API` / `C API`) is refused when the rules compile.
- **Required subfolders.** `required: true` can be set on a rule whose last segment is a literal. That folder must exist whenever its parent does.
- **Required files.** `files: { <leaf>: { template, type? } }` lists files that must exist in every folder the rule matches.
- **Scaffolding.** Whenever a write brings a folder into existence, its required subfolders (recursively) and required files are created with it. That covers a document create, a move, an import, or an explicit "new folder".
  - Required files are written as **drafts** from their template. A required file cannot be a `pdf`, `source` or `skill` (each needs data a template cannot supply), and when it declares a `type`, a document there must have that type.
  - Scaffolding happens only for **enforced** writes that are **not held for review**, and it is best effort: it never fails the write that triggered it. Whatever it could not create shows up in the compliance report.
  - Placeholder folders are never scaffolded, because the engine cannot invent a client name.
  - Scaffold writes run inside the same vault lock as the write that triggered them.

### 3.5 Violations

| Code | Meaning |
|---|---|
| `FOLDER_NOT_ALLOWED` | `closed` is on and no pattern matches the folder |
| `FOLDER_NAME` | a folder segment fails its format |
| `TYPE_NOT_ALLOWED` | the node type is not in the folder's `types`, or a required file is not the `type` it declares |
| `FILE_NAME` | the id's leaf fails the folder's `file_name` |
| `MISSING_SECTION` | a heading listed in the template's `required_sections` is absent |
| `MISSING_FOLDER` | a required subfolder is absent |
| `MISSING_FILE` | a required file is absent |

### 3.6 Enforcement semantics

With **`enforce: true`**:

- **Create, move and import** are checked in full. Import is checked after the importer has settled its final paths, including any `-2` collision suffixes.
- **Update** cannot change the id. It is refused only if:
  - it switches the node to a type that isn't allowed, or
  - it removes a required heading the existing body had.
- **Delete** of a required file is refused while its folder (subfolders included) holds any other document; deleting it last is allowed, so a folder can be emptied even where no folder-delete operation exists. Deleting a required subfolder on its own is refused; deleting its parent is allowed.
- **Grandfathering.** A document that broke the rules before they were saved stays readable and editable. Nothing new lands in the wrong place, but nothing old is locked. `MISSING_FOLDER` and `MISSING_FILE` on folders that already existed are report-only, and the Compliance list offers to create them.

With **`enforce: false`** (the default), every rule is **report-only**: the rules write nothing (no scaffolding) and refuse nothing; violations appear in the compliance report. This is the rollout step. A rule that does not compile refuses writes only in an enforced vault; `context_structure` reports it as `error` rather than throwing.

**Approvals are re-checked.** Approving a held edit (`approveReview`) or a drift suggestion (`approveSuggestion`) is judged against the rules in force at approval time, for what the edit newly breaks. So is a held create when it is approved.

**Refusals reuse `VALIDATION_FAILED`.** The message names the rule and the expected format, for example:

```text
"notes/" is not an allowed folder. Allowed: clients/{client}/meetings, decisions, reports/{yyyy} — see ctx structure
File names in clients/acme-042/meetings must look like {date}-{slug}; "kickoff" does not (start the title with a date)
```

There is no new error code and no change to any wire shape. Agents self-correct from the message, and the UI shows it verbatim.

## 4. One read path for every surface: `context_structure`

A new **core catalog operation**, `context_structure`, is the single way to read the rules.

```text
input:  { folder?: string, report?: boolean }
output: { enforce, closed,
          folders:    [{ pattern, types, folder_name, file_name, template, required, files }],
          templates:  { <name>: { body, required_sections } },
          resolved?:  { …the rule governing `folder`, with its template body… } | null,   // when folder is given
          violations?: [{ code, path, rule, message }],                         // when report: true
          warnings?:  [string],   // rules that compile but look wrong (an unresolved template name)
          error?:     string }    // the rules do not compile — reported, never thrown
```

| Consumer | How it reads the rules |
|---|---|
| OSS MCP server | It registers core ops by looping `listOperations("core")`, so `context_structure` appears with no extra work. |
| `ctx` CLI | New `ctx structure [--folder <path>] [--report] [--json]`. Against a local vault it runs the op through the engine API. Against a Community nest (`--vault work` or `<server>/<nest>`) it routes through `cli/src/remote.ts` → `conn.run("context_structure")` over MCP. The `--json` output is **shape-identical** either way, which is the `remote.ts` invariant the plugins rely on. |
| Coding-agent plugin | Uses `ctx structure`; see below. |
| Community REST | `GET /nests/:id/structure?folder=&report=1` (read tier) is the REST binding of the same op. |
| Community MCP | A `context_structure` tool on the per-nest `/mcp` and on the server-level MCP; remote `ctx` calls this. Its descriptor is imported from `@promptowl/contextnest-engine/api`, with no inline schema (`npm run lint:mcp-schemas`). |

**Plugin** (edited in `plugins/shared/` only, then `pnpm plugins:sync`):

- `core/session-start.js` runs `ctx structure --json` once, for the pinned or working-directory vault only. When rules exist, it injects a compact blueprint: patterns, allowed types and name formats, at most about 15 lines, plus "run `ctx structure --folder <f>` before writing".
  - It stays a pure `run({ input, env, exec })` and is tested with a fake `exec`.
- `prompts/capture.md` and `prompts/curate.md` tell the capture and curator agents to run `ctx structure --folder <f> --json` before `ctx add` or `ctx move`. The agent then picks an allowed folder, writes a title that fits the name format, and starts from the template body, keeping its required sections.
- A refusal from `ctx` names the rule, so an agent that skips the check still recovers.

## 5. Engine phase (upstream — PromptOwl/ContextNest)

Per the sync discipline, all of this lands in the engine repo first and ships in an engine release. Community consumes it.

- **Config schema** (`packages/engine/src/schemas.ts`, `nestConfigSchema`):
  - add `structure { enforce?, closed? }` and `templates`;
  - extend `folders` entries with `types: z.array(z.string())`, `folder_name`, `file_name`, `required` and `files`.

  The schema checks **shape only.** `parseConfig` throws on any schema failure, and the config is read on every write and on graph reads (`graph-query-engine.ts:225`). A strict enum or pattern check there would let one typo brick the whole vault. Patterns, regex and type names are compiled when they are used, and a bad rule refuses *writes* with `CONFIG_ERROR` while reads keep working.

- **New pure module `packages/engine/src/structure.ts`.** No IO.
  - `compileStructure(config)` compiles tokens and regex, including the safety checks in §3.3.
  - `checkDocument`, `checkUpdate(existing, next)`, `checkFolder`, `checkDeleteDocument(rules, id, others)` and `checkDeleteFolder` return violations.
  - `scaffoldPlan(rules, newFolders)` returns the folders and files to create.
  - `auditStructure(rules, docs, folders)` produces the compliance report.

- **`setStructure(storage, rules)`.**
  - It validates with `compileStructure`, then rewrites only the `structure`, `folders` and `templates` blocks under the vault lock.
  - The rest of the file, comments included, is left byte-for-byte alone. This is the approach `setReviewMode` takes (`review.ts:76`), because `writeConfig` round-trips through the schema and strips unknown keys and comments.

- **Enforcement and scaffolding** in `packages/engine/src/api/core-executors.ts`:

  | Write | What runs |
  |---|---|
  | `context_create` | reserved-path guard, then `checkDocument` before the write (held creates too); scaffolding unless held |
  | `context_update` | `checkUpdate` against `existing`, which is already the pending proposal when the edit is held for review |
  | `context_import` | `files[]`: verdicts for the whole batch after `planImportPaths` (a refused document takes its history, staged edits and PDF sidecar with it; an overwrite is judged as an update); `documents[]`: guard + `checkDocument` |
  | `context_import_pdf` | guard; `checkDocument` for a new PDF, `checkUpdate` for a new version; scaffolding |
  | `context_delete` / deprecated `delete_document` | `assertStructureDelete` |
  | deprecated `create_document` / `update_document` | guard + `checkDocument` + scaffolding / `checkUpdate` (they write storage directly) |
  | every publish, approvals included | `publishDocument`/`publishDocuments` judge it against the rules in force (`assertStructurePublish`: a first publish in full, a later one against the sealed head) and scaffold first publishes (`scaffoldFirstPublish`); `commitNewVersion` does the same for suggestion approval, rollback and czar direct edits |
  | `context_publish` | a first publish is judged in full and scaffolds the folders the document alone occupies; a later publish is judged against the last sealed version (an out-of-band edit). Community's review approve publishes through this op, so it is covered with no Community-side check |
  | `ctx pull` | guard on `includes[].to`; `checkDocument`/`checkUpdate` per pulled document (a refusal is reported as a conflict); scaffolding |

- **Security fix.** `context_import`'s `files[]` refuses paths under `.context/`. Today `overwrite: true` lets any caller rewrite `config.yaml`, which means the structure rules *and* the review gate. No write op accepts a document id under a reserved path either (see §3.2; `assertWritableDocumentId`).
- **Shared IO helpers** (`structure-store.ts`, exported): `enforcedStructure(storage)` (the rules only when enforced), `missingFolders(storage, id)` and `scaffoldFolders(storage, rules, created)` (best-effort scaffolding), `assertStructurePublish(storage, rules, node)` / `structurePublishViolations` and `scaffoldFirstPublish(storage, rules, ids)` (called by every publish), `isEnforced(config)`, `assertStructureUpdate(storage, id, beforeRaw, afterRaw)` and `assertStructureDelete(storage, id)` (the required-file guard; it counts document files of any status from directory listings — rejected and forgotten files count, and each can be deleted first). Approvals, `ctx pull`, the legacy MCP tools and Community's own write paths use these, so nobody re-implements scaffolding or the enforce gate.

- **Skip flag.** A new `OperationContext.structure?: "skip"`. It is set only by trusted binding code for system writers (see §6) and is never read from operation input. Under it the rules are not enforced, and `context_import` may land `.context/` files: that is how a bundle restore brings the source nest's `config.yaml`, rules included.

- **New op and CLI.** Add `context_structure` in `api/core.ts`, the `ctx structure` command in `cli/src/index.ts`, and `remoteStructure` in `cli/src/remote.ts`.

- **Plugin.** The changes are listed in §4.

- **Spec.** Add a §11.1.1 subsection with paragraphs for `structure`, `folders` patterns and formats, `templates`, and required and scaffolded structure. Add a §17 changelog line.

- **Mixed versions.** An older engine strips the unknown keys, so there the rules are advisory. Release notes must say so.

## 6. Community phase

### 6.1 Where a nest's rules are stored

The rules for a nest live in that nest's vault, in `<NEST_STORAGE_ROOT>/<id>/.context/config.yaml` (default `<DATA_ROOT>/nests/<id>`, via `resolveNestPath`). They are **not** database columns, unlike the nest settings that `NestSettingsModal` edits (`stewardship_enabled` and similar on the `nests` table, `src/nests/service.ts`). The vault is the right home because:
- the engine enforces them on every write path, including MCP and `ctx` against a Community nest, which never touch Community's database;
- bundle export and restore already carry `.context/config.yaml` (it is on the export allowlist, `src/nests/bundle-service.ts:123`), so a nest moved between servers keeps its rules;
- the CLI, the plugin and a downloaded vault all read the same file.

Community writes the file **only through the engine's `setStructure`**. It rewrites the three rule blocks and keeps every other key, its comments and its line endings. Community never writes `config.yaml` itself, and never parses rules.

**Prerequisites from the engine** (upstream, before this phase):
1. A released engine version that carries the feature. The pin is `^2.9.1` today, and the feature is still on the branch.
2. `setStructure` must create a minimal `config.yaml` when a vault has none. Imported nests (`createImportedNest`, `FlatNestStorage`) may not have one. *Built:* until it does, `PUT` refuses such a nest with a 400 that names the problem (never the vault's path).
3. *Built differently:* the GET route renders the saved rule blocks as YAML itself (`js-yaml`, presentation only), so `context_structure` did not need a `yaml` field. The engine does export `structureReport(storage, rules)` (engine round 22), so a draft is judged against the nest's content by the engine's own report, not a copy of it.

### 6.2 REST

All three routes live in a new `src/structure/routes.ts`, mounted under `nestsApp` in `src/app.ts` (around line 2706) like the other domain routers.

| Route | Who | What it does |
|---|---|---|
| `GET /nests/:id/structure?folder=&report=1` | anyone who can read the nest | Runs `context_structure` through `opContext`. Returns the rules, the resolved rule for `folder`, the compliance report with `report=1`, the saved blocks as written (`rules`, what the editor starts from, so a save sends back the owner's own spellings), the same as `yaml`, and the node types the server accepts (`types`). |
| `PUT /nests/:id/structure` | owner or admin (`canManageStewards`, `src/governance/stewardship-service.ts:822`); never a nest-scoped API key (the handler checks `c.get("nestScope")`) | Validates with `compileStructure`, then saves with `setStructure`. Records a `structure_changed` activity entry. Returns the new rules and the number of existing violations. |
| `POST /nests/:id/structure/check` | read tier; owner or admin when `rules` is sent | The validation API the UI uses for every live check (§6.3). |

**Middleware.** The nest middleware raises every non-GET request to the `write` tier unless it is exempt (`src/app.ts`, `isReadQuery`). `structure/check` joins those exemptions, so viewers can check names in the new-document form. Its handler raises the tier itself when `rules` is present. `PUT` passes the write tier and then checks `canManageStewards`.

**Errors** reuse the shape `PATCH /admin/settings` already returns: `{ error, fieldErrors }` with status 400. `fieldErrors` is keyed by the rule key it names, for example `folders["clients/{client}"].folder_name`, so the editor can put the message under that field. This replaces the `errors: [{ key, message }]` shape in the first draft of this doc. An engine refusal on any write path (`VALIDATION_FAILED`) becomes a 400 `ValidationError`, never a 500 (see §6.4).

**Audit.** The activity log is document-centric today (`ACTIVITY_TYPES` in `src/governance/scoped-activity-service.ts`). Add a nest-level `structure_changed` type, recorded with:
- the actor;
- the summary counts (rules added, removed and changed; templates changed; enforce or closed switched);
- the rules before and after, so the change can be reviewed later.

`logTraceEvent` keeps writing its usual trace row.

### 6.3 The check API

The UI contains no engine logic: no matcher, no token logic, no regex, no YAML. Every check is a server call, debounced to about 300 ms.

```text
POST /nests/:id/structure/check
body:     { rules?, report?: true,
            tests?: [{ folder?, title? | name?, type?, body?, file_name? | folder_name? }],
            folders?: [path] }
response: { fieldErrors, error?, warnings: [string],
            results: [{ ok, slug, violations }],           // one per test
            folders: [{ folder, violations, creates: { folders: [path], files: [{ path }] } }],
            report?: { violations } }                     // existing content, judged by these rules
```

- **Without `rules`,** everything runs against the saved rules. The create flows use this.
- **With `rules`** (owner or admin only), the draft is compiled first, regex limits included. `fieldErrors` points at the key at fault, and `warnings` names what compiles but looks wrong: a template name with no entry, or a required section that is not a heading in its template's body.
- A test with `file_name` or `folder_name` tries the name against that format alone (the editor's "Try a title" / "Try a folder name"): the engine compiles a one-rule set holding just that format and judges the slug. Trying it in a folder built from the rule's own path does not work — `clients/{client}` becomes `clients/client`, which a folder-name format refuses, so no rule governs it and a bad title reads as fitting (found in the local run).
- Sections are judged only when a test carries a `body`: a title check has none yet.
- Each `folders` entry answers "does this folder fit, and what will creating it also create?" (`checkFolder` and the engine's `scaffoldPlan`), for the new-folder preview.
- `report: true` judges the nest's existing content against the draft, for the count in the "Enforce" confirmation before saving.
- **Caps:** 256 folder rules, at most 50 `tests` and 50 `folders` per call. Larger bodies get 413 or 400.
- On the server it calls the engine's exported `compileStructure`, `checkDocument`, `checkFolder`, `scaffoldPlan` and `structureReport`. `slug` comes from Community's own `slugify` (`derivedNodeId`, which now takes a folder), because that function builds Community's ids. The UI therefore shows exactly what the server will enforce.
- The nest middleware exempts `POST /structure/check` from the write tier; the client's cache treats it as a read (no invalidation), and a `PUT` invalidates only the structure reads.

**Built (this branch):** the three routes, the global mapping of the engine's `VALIDATION_FAILED` to a 400 (so a refused create names the rule instead of a 500), the Structure nest page (Blueprint, Templates, Compliance, the Enforce confirmation with the count it would refuse, View YAML, read-only for non-managers, a per-nest empty state), "Structure rules" in the nest menu, and a Ruler button on folder rows (`?folder=`). **After the UX review** (a reviewer drove the real app as owner, editor and viewer through every documented failing rule):
- An edit or a delete a rule refuses is a 400 naming the rule — it was a "reload and try again" 500, and "Node not found" for a required file. Refusals point people at the Structure page, not at `ctx structure`.
- `moveNode`, `createEmptyFolder`, `deleteFolder` and deletion requests enforce the rules through the engine's own checkers (`src/structure/writes.ts`): a move is judged as a delete there and a create here, a new folder must fit and gets its required children, a required folder cannot be deleted alone, a whole folder deletes deepest first with required files last, and a request to delete a required file is refused when asked rather than at approval.
- The page asks before leaving with unsaved rules (the app's nav guard and the browser's), shows the saved mode with an "Enforced after Save" chip, words rule keys for people, confirms removing a rule with subfolder rules or a template in use, and has a save bar on phones.
- Compliance is grouped by problem with a "N problems in M places" summary and an action on every row: Open, Show folder, Create folder, Create from template.
- People who cannot edit read each rule in words and can still try titles and folder names; a folder with no rule says so. A title with no a–z letters or digits is checked as the generated name it will get.
- Contrast (errors in red-700), labels and live regions for the checks; no horizontal scroll at 390 px.
- Engine round 26 added the warnings the review asked for: a required section that is not a heading in its template's body, and an unclosed `{` in a name format.

**Every way in, with enforcement on** (`test/structure-enforcement.test.ts`, and a live run of the real `ctx push` against a served app): a document that breaks a rule never lands, whichever door it uses — the app's create, update, move, new folder and folder delete; `ctx push` (`POST /publish`), where each such document fails alone naming its rule (it said "Could not create this document") and the push exits 1; a push held for confirmation, now refused when sent if any document breaks a rule, so a reviewer is never asked to confirm what cannot land (`assertPushConforms`, in `createPendingPush`, which every held write goes through); the nest's MCP `context_create`, `context_update` and `context_move`; and an out-of-band edit approved from the app. An import cannot carry rules (the engine refuses `.context/`). Files written straight onto the server's disk are not a write the app makes; they show on the Compliance tab.

**Not yet:** the `structure_changed` activity type (the request trace records every save), the new-document / new-folder / move-dialog pre-checks and template pre-fill (§7.5), the settings-dialog summary row, the path builder (rule paths are typed), "Copy rules from another nest", the skip flag for import staging (§6.4), and MCP `context_structure`.

### 6.4 Write paths and the skip flag

- **Write paths that don't go through an engine op** call the engine's exported `enforcedStructure`, its checkers, `missingFolders` and `scaffoldFolders` directly, never a copy of them:
  - `moveNode` (`src/nodes/service.ts`) checks the destination and scaffolds any new folder. A move keeps the file's name, so a non-conforming name cannot move into a folder with a name rule until a rename op exists (§12). The engine should export this placement sequence as one helper first (architecture review, round 5).
  - `createEmptyFolder` checks the folder and scaffolds its required children.
  - `deleteFolder` first calls `checkDeleteFolder` on the folder itself, then passes the skip flag for its own children, so the required-file guard does not block deleting the whole folder.
- **Skip flag.** `opContext` (`src/nodes/engine.ts:430`) passes `structure: "skip"` the way it passes `limits`, and only for system writers that bring or derive content rather than author it:
  - the annotations projection;
  - import staging (`stageImportedFiles`): nest import, bundle restore and `context_sync_folder`, which bring a whole vault, rules included.

  Revert and agent-activity undo stay enforced.
- **Error mapping.** `createNode` maps the engine's `VALIDATION_FAILED` to `ValidationError` (400), so bulk publish (`src/nodes/publish-apply.ts`) reports the rule rather than "Could not create this document". A held push is judged when it is sent (`assertPushConforms`).
- **MCP.** Add `context_structure` to `TOOL_DEFINITIONS` (`src/mcp/tools.ts`) and to `SERVER_NEST_TOOLS` (`src/mcp/server-routes.ts`). Its schema comes from the engine's operation catalog, never a new inline literal (`npm run lint:mcp-schemas`).
- **Docs.** `API.md` (the three routes and the refusal messages) and `STEWARDSHIP.md` (who edits rules).

## 7. How a user adds rules in the UI

### 7.1 Where it appears

**A new nest page, "Structure"**, registered like Board, Graph, Definitions and Workflows:

```ts
// ui/src/pages/nest/structure/meta.ts
export default {
  path: "structure",
  label: "Structure",
  icon: FolderTree,          // lucide
  order: 5,
  viewPage: "structure",
  visible: (caps) => !caps.isReaderView,
} satisfies NestPageMeta;
```

Registering it also touches:
- the `View` union and `NestScopedView` (`ui/src/App.tsx`);
- the `viewPage` union (`ui/src/lib/nest-pages.ts`);
- `READER_HIDDEN_VIEWS` (`ui/src/lib/nest-caps.ts`);
- the hard-coded list in `nest-pages.test.ts`.

The URL is `/nest/<id>/structure`. `?folder=<path>` selects that folder's rule, or starts a new rule for it. The page gets `nestId` from `useNestPage()`, fetches `reads.nest(nestId)` and calls `deriveNestCaps`, as `DefinitionsPage` does. `caps.canManage` decides whether it can edit. Everyone except reader view sees the page; non-managers see it read-only.

**Ways in:**
1. **Navigation:** the nest header tab strip and the sidebar "Views" group, both drawn from the registry.
2. **Nest header ⋯ menu** (`NestView` `OverflowMenu`): a **"Structure rules"** item next to "Nest settings", for owners and admins.
3. **Nest settings dialog** (`NestSettingsModal`): a summary row, "Structure rules · Enforced · 4 folder rules · Open →".
4. **The folder itself:** folder rows in the Documents tab have hover icon buttons (Plus, Share2, Activity, Trash2, in `DocumentsTab.tsx`), not a ⋯ menu. Add a **Ruler** icon button, "Rules for this folder", which opens `/nest/<id>/structure?folder=<path>`.

### 7.2 Page layout

Built only from the components the app already has (`ui/src/components/ui/`):
- `PageTitle`, `Tabs`, `Card`, `Input`, `Select`, `Checkbox`, `Switch`, `Badge`, `Button`, `Alert`, `AlertDialog`, `Dialog`, `Tooltip`;
- sonner toasts, `CodeHighlight` for YAML, and a plain `<table>` as elsewhere.

There is no sheet, no table primitive and no chip input, so the few new pieces are small local components in `ui/src/components/structure/`.

```text
┌ PageTitle ─────────────────────────────────────────────────────────────────────┐
│ ▣ Structure                                   [Report only ▾] [View YAML] [Save] │
│   Which folders can exist here, what goes in them, and how files are named.    │
├────────────────────────────────────────────────────────────────────────────────┤
│ Enforce rules [ ○ ]   Closed structure [ ● ]           Unsaved changes ·       │
│ [ Blueprint ] [ Templates ] [ Compliance  12 ]                                 │
├──────────────────────────────┬─────────────────────────────────────────────────┤
│ Folder rules        [+ Rule] │ clients / {client} / meetings                   │
│ ▾ clients/{client}           │ ─ Path ─────────────────────────────────────────│
│     overview · required      │  clients   Fixed name                           │
│   ▸ meetings   required      │  {client}  Any name   Format [Custom ▾] /[a-z]+…/│
│   ▸ contracts  required      │  meetings  Fixed name             [+ level]     │
│ ▸ decisions                  │ ─ What can be added here ───────────────────────│
│                              │  [✓] Document [ ] Snippet [ ] PDF …             │
│                              │ ─ File names ───────────────────────────────────│
│                              │  [Date] [-] [Title]  + Year + Number + text     │
│                              │  Try a title [Kickoff with Acme]                │
│                              │  ✗ "kickoff-with-acme" — must start with a date │
│                              │ ─ New files start from ─────────────────────────│
│                              │  [meeting-note ▾]  + New template…              │
│                              │ ─ Required ─────────────────────────────────────│
│                              │  [✓] Create with its parent folder              │
│                              │  Required files: overview · client-overview  ×  │
└──────────────────────────────┴─────────────────────────────────────────────────┘
```

- **Blueprint tab:**
  - **Rule list (left).** The rule patterns drawn with `FolderTree`'s render props. Each row shows its pattern, plus badges for `required`, its template, and its required files.
  - **Rule editor (right).** Laid out as the first draft of this doc described:
    - the path builder, one row per level (Fixed name or Any name, with a format for Any name: Any, Year, Date, Number or Custom regex);
    - allowed types (checkboxes from the server's accepted node types);
    - the file-name builder (token chips, Custom regex or Any);
    - the template select, with "+ New template…";
    - "Create with its parent folder";
    - required files.
  - **Live checks.** Every **Try** box and every field calls the check API with the draft rules (debounced), and shows the derived slug and the server's verdict.
  - **Narrow screens.** The two columns stack, and the editor opens below the list.
- **Templates tab:** a list of templates and an editor for each.
  - **Body:** a monospace `Textarea`, because the exact markdown headings matter.
  - **Required sections:** a chip list. Type a heading and press Enter to add it. The check API warns when a required section is not a heading in the body; the UI never parses the markdown.
  - **Where it's used:** the folders that use the template.
- **Compliance tab:** the saved rules' report (`GET ?report=1`) in a table grouped by violation code: Code, Path, What's wrong, Actions.
  - **Actions:** **Open** (`openDocument`) and **Move…** (the existing move dialog) on every row. A `MISSING_FILE` row adds **Create from template**, and a `MISSING_FOLDER` row adds **Create folder**.
  - **Count:** the tab label shows it as a `Badge`, since nest pages have no badge field.
  - **Empty:** "Everything in this nest fits the rules."
- **View YAML:** a `Dialog` showing the saved blocks (the `yaml` field) with `CodeHighlight`, and a Copy button. It is read-only; hand-editing YAML stays out of scope (§12).

### 7.3 Saving, enforcing and states

- **Draft state.** The page keeps one draft of the three blocks in local state. A "Unsaved changes" marker appears beside the switches, and leaving the page with changes asks for confirmation (`AlertDialog`).
- **Save** sends `PUT /nests/:id/structure`.
  - **On a 400,** each `fieldErrors` message appears under the field it names, `aria-invalid` is set as in `TextField` on the admin settings page, and an `Alert` above the editor sums up the problems.
  - **On success,** a toast reads "Structure rules saved", and the structure queries are refreshed.
- **Turning Enforce on** opens an `AlertDialog` with the count from the check API (`report: true` with the draft): "12 existing items still don't fit. They stay readable and editable, but new documents, moves and imports that break these rules will be refused for everyone: editors, agents and `ctx`." → **[Enforce rules]**. Turning it off needs no confirmation.
- **Removing a rule** that has subfolder rules asks for confirmation. Because existing content is grandfathered, a save never breaks what is already there.
- **Read-only view** (not an owner or admin): every control is disabled, and an `Alert` reads "Rules are managed by the nest's owners and admins." Editors use the page to learn where things go.
- **Other states:**
  - **Loading:** skeleton rows.
  - **Empty:** "No structure rules yet. Rules decide which folders can exist, what goes in them, how files are named, and which templates they start from." → **[+ Add folder rule]** **[+ Add template]**
  - **Saved rules don't compile** (hand-edited YAML): an `Alert` shows the server's `error`, and the editor still opens so it can be fixed.

### 7.4 Data layer

- **`ui/src/lib/api.ts`:** `getStructure(nestId, { folder?, report? })`, `saveStructure(nestId, rules)` and `checkStructure(nestId, body)`. These use the existing `request<T>()` and `ApiError {status, body: {error, fieldErrors}}`.
- **`ui/src/lib/queries.ts`:** `keys.nest(id).structure(...)`, `reads.structure`, and the hooks `useStructure(nestId)` and `useStructureFolder(nestId, folder)`. A save invalidates `keys.nest(id).structure`, and a non-GET call already clears the read cache for its path.
- **`ui/src/lib/structure-draft.ts`:** pure mapping between the API's rule shape and the form's rows (path levels and name-format presets). It is data shaping only, with no validation; validation is the server's job.

### 7.5 Where editors meet the rules

- **New document** (`DocumentEditor` with `nodeId: "new"`):
  - **Choosing a folder** (`FolderStepPicker`) loads `useStructureFolder`.
  - **Body:** pre-filled from the folder's template, while the user hasn't typed yet.
  - **Type:** the type radiogroup offers only the folder's allowed types.
  - **Title hint:** for example "File names here: `{date}-{slug}` — start the title with a date".
  - **Live check:** title, folder and type are checked as the user types, using the check API's `tests` with the saved rules. It shows "Saved as `2026-10-07-kickoff.md` ✓" or the server's reason.
  - **On save:** a refusal still possible at that point shows verbatim in the existing error `Alert`.
- **New folder** (the dialog in `NestView.tsx`): `checkFolderPath` still does the syntax checks, then the check API (`folders`) shows the expected name format or the refusal, plus a preview from `scaffold`: "Also creates: overview.md (client-overview), meetings/, contracts/".
- **Move** (the `DocumentsTab` dialog, the `DocumentEditor` dialog, Board drag-and-drop): the destination is pre-checked with the check API, so a folder that can't take the document says why before the move. A refusal at move time shows the server's message (`toast.error`).

## 8. Experience walkthrough

- **Owner.**
  - Opens Nest → Structure and builds the blueprint:
    - `clients/{client}`, where client folder names must match `/[a-z]+-[0-9]{3}/`, with a required `overview` built from the client-overview template;
    - required `meetings/`, with Date-Title names and the meeting template;
    - required `contracts/`, PDF only;
    - `decisions/`, with an ADR regex.
  - Saves with Enforce off. The Compliance tab shows 12 misfiled documents and 3 client folders without an `overview`.
  - Clicks "Create from template" three times, moves a few documents, then switches Enforce on.
- **Editor.**
  - Creates folder `clients/acme-042`. It arrives with `meetings/`, `contracts/` and a draft `overview`. Trying `clients/acme` shows the expected format before they submit.
  - New document in `meetings/`: the editor is pre-filled from the template. The title "Kickoff" shows a date-first hint, and "2026-10-07 Kickoff" passes.
  - Deleting the Decisions heading and saving is refused with "Decisions is a required section in meetings/".
- **Coding agent with the plugin.**
  - At session start it sees the blueprint.
  - When capturing a meeting note it runs `ctx structure --folder clients/acme-042/meetings --json`, gets the format and template, and runs `ctx add` with a conforming title and the template's sections. That write lands first try.
  - The identical flow works against a Community nest, because `ctx` routes `context_structure` over MCP.
- **Any MCP agent.** A `context_create` into `notes/` is refused with a message listing the allowed folders. The agent calls `context_structure`, or just reads the message, and retries correctly.

## 9. Phases

1. **Engine (upstream PR, minor release):** schema, `structure.ts`, `setStructure`, enforcement and scaffolding in the executors, the `.context/` import fix, the `context_structure` op, `ctx structure`, the plugin changes, and the spec text. *Implemented test-first on `PromptOwl/ContextNest` branch `claude/context-nest-hard-rules-design-yhcj6z` (§10).*
2. **Community API and enforcement:** engine release and bump (with the §6.1 prerequisites), the three REST routes, the `structure_changed` activity type, the MCP tool, `moveNode`/`createEmptyFolder`/`deleteFolder` checks, the skip flag, and the error mapping.
3. **Community UI:** the Structure page (Blueprint, Templates and Compliance tabs, View YAML), its four entry points, and the create, new-folder and move integration (§7).

Each phase is shippable on its own:
- After phase 1, local vaults and the OSS MCP server have rules, edited by hand in `config.yaml`.
- After phase 2, Community nests enforce rules set via the API.
- Phase 3 adds the owner-facing editor.

## 10. Test plan (TDD) and QA

Every phase is built **test-first**:

1. Write the failing tests for the phase (red), run them, and confirm they fail for the right reason, such as a missing module or the wrong behaviour.
2. Implement until they pass (green), and keep every existing suite green.
3. Hand the phase to the **QA agent** (`.claude/agents/qa-adversary.md`, in both repos). It only **runs** the suites and **attacks** the change. It never edits code. It reports blocking findings with exact repros and ends with a `PASS` or `BLOCKED` verdict.
4. Each blocking finding is fixed test-first: a failing test that reproduces it, then the fix. QA runs again until the verdict is `PASS`.

### 10.1 Engine phase (ContextNest) — QA PASS, architecture Approve with nits (round 31, `f5f11bd`)

- Round 1 (`9c8c3a3`) passed every suite, but QA and the architecture review returned `BLOCKED` / `Needs rework`: ReDoS bypasses, closed-mode bypass through system-path look-alikes, legacy configs refusing writes, a stranded write when scaffolding failed, and unenforced paths (deprecated `delete_document`, `ctx pull`, approvals).
- Round 2 (`e81d3f1`) wrote a failing test for every finding, then fixed them. Both reviewers re-ran and found more:
  - a zero-padded quantifier still hid from the regex check;
  - root `packs/` / `_suggestions/` in flat vaults;
  - backslash ids;
  - `.context` through `create_document`;
  - per-write regex amplification;
  - non-ASCII section anchors;
  - template typos;
  - held creates never scaffolded.
- Round 3 (`4caf32f`) fixed those test-first. The architecture review then found two more: `files[]` imports skipping the reserved-path guard, and ~3 s of regex work for one write across 256 distinct 3-quantifier rules. It also found case-folding gaps, and approvals that publish through `context_publish` not being re-checked.
- Round 4 (`70c36f0`) fixed those test-first. QA's round-3 run (on `4caf32f`) still found blockers:
  - one regex shape that took ~1.5 s, ×256 rules;
  - reserved paths reachable through `ids[]` and `context_publish`;
  - malformed rule keys breaking every write even when not enforced;
  - `ctx init` dropping the rules on re-init, and starters writing past them.
- Round 5 (`47113eb`) fixed those test-first:
  - the linear-time matcher above;
  - a config schema that leaves the rule keys to `compileStructure`;
  - the reserved-path guard on every publish, with full case folding, NTFS stream suffixes and control characters;
  - rules carried over a re-init, and starters filtered through them.

  On that head QA returned `BLOCKED`, though all four round-3 blockers were confirmed fixed:
  - a 20,000-deep id held the vault lock for ~27 s before failing;
  - one class form (`[\d-a-z]`) disagreed with ECMAScript Annex B.

  The architecture review returned `Needs rework`:
  - only two publish paths judged and scaffolded a first publish;
  - an update wrote its file before the reserved-path guard ran;
  - `Nodes/` was not recognised as `nodes/`;
  - token patterns still ran on the backtracking `RegExp`.
- Round 6 (`56d8320`) fixed those test-first:
  - ids over 1024 characters, or with a name over 230 bytes, are refused before any file-system call;
  - Annex B class unions;
  - `publishDocument(s)` judge every publish and scaffold a first one (`assertStructurePublish` / `scaffoldFirstPublish`), so every approval surface agrees;
  - updates check the guard before writing, and trusted restores no longer lift it;
  - roots are recognised case-insensitively;
  - token patterns run on the linear matcher, so no `RegExp` ever runs on a name;
  - non-boolean `enforce` fails closed;
  - `NestStorage.init` keeps the rules over a re-init;
  - `setStructure` refuses a config symlinked outside the vault.

  On that head both reviews found more. QA returned `BLOCKED`:
  - case-folded roots let `NODES/` and `nodes:x/` skip closed rules on case-sensitive volumes;
  - scaffolding a deep id's first publish still cost depth² directory reads (11 s at depth 500);
  - the trailing-dot trim regex was quadratic.

  The architecture review returned `Needs rework`:
  - czar direct edits and rollbacks sealed versions with no guard;
  - the publish judge broke chain recovery when history was damaged.
- Round 7 (`88e696a`) fixed those test-first:
  - fold to refuse, never to exempt: the checker compares roots exactly, and the guard refuses other spellings of `nodes/`;
  - one directory crawl per top-level folder, with held-for-review siblings ignored when scaffolding;
  - a linear trim;
  - `commitNewVersion` guarded and judged;
  - damaged history judged in full, judged before any repair;
  - import overwrites judged as their publish, and planted history refused;
  - a malformed `structure` switch fails closed;
  - a stricter re-init guard;
  - starters published as one batch.

  On that head QA returned `BLOCKED`:
  - a quadratic `/#+$/` in heading parsing, reachable through required sections;
  - batch scaffolding still quadratic across wide batches (45 s for 200 docs × depth 100);
  - a `./` segment slipping planted history past the import guard.

  The architecture review returned `Needs rework`:
  - deletes and forgets never checked reserved paths (a keyframe could be unlinked);
  - NTFS 8.3 short names (`VERSIO~1`) aliasing reserved folders.
- Round 8 (`d8e997a`) fixed those test-first:
  - `assertNotMachineryPath` on every delete, forget and storage write, refusing 8.3 short names too;
  - linear trims;
  - one-pass subtree totals: 100 docs × depth 100 drops from 9.3 s to 1.4 s;
  - `.`-normalized store owners;
  - planted history refused only for a document its full check refuses, so a chunked import can send a document before its history;
  - the `nodes/` respelling made a structure violation, so vaults without rules are unaffected;
  - only published documents occupy a folder for scaffolding;
  - `structure: false` is off;
  - re-init refuses any invalid YAML;
  - import paths are size-checked.

  On that head the architecture review returned `Needs rework`:
  - planted history was judged by the live document, not by its own head;
  - an imported forget naming `../otherNest/…` erased another nest's history;
  - an import could replace a sealed PDF binary;
  - the `~digit` rule made legacy `draft~2` ids unerasable.

  QA returned `BLOCKED`:
  - the same planted-history bypass;
  - `~digit` names frozen even in vaults without rules;
  - a quadratic array spread in batch scaffolding.
- Round 9 (`1c7c5de`, `16b6069`) fixed those test-first:
  - every imported `.versions/<doc>/` set must arrive whole and rebuild to a head that passes the full check;
  - forgets, imported ones included, refuse non-document ids before touching history;
  - a sealed PDF binary is replaced only by identical bytes;
  - a `~digit` name is judged where it resolves (`assertResolvesOutsideMachinery`) on every write and erase, never by its spelling;
  - default-ignorable code points are dropped in name comparisons;
  - scaffolding appends with `push` (20,000 folders: 19.8 s → 0.35 s).

  The architecture review returned `Needs rework`: the import verdict rebuilt a history from the call's files while grandfathering replayed the disk, so a stale diff planted earlier changed the head after the verdict.

  QA returned `BLOCKED`:
  - a decoy under `.versions::$DATA` vouched for the real history beside it;
  - a deep `~` erase held the lock for ~12 s;
  - an in-batch `.md` let a sealed PDF be replaced;
  - a `..x` folder escaped the alias check.
- Round 10 (`9ceb7de`, `bf00665`) fixed those test-first:
  - `sealedHead`: grandfathering trusts only a head rebuilt from its last keyframe with every replayed entry matching its `content_hash`, and judges in full otherwise;
  - the import verdict judges what the nest will hold after the call, and refuses a history that does not rebuild and verify or ends in a refused version;
  - look-alike machinery folders are refused before judging;
  - sealed PDFs, sidecar or archive, are never replaced by other bytes;
  - deep-prefix resolution is a binary search;
  - reads refuse ids no file system holds.

  The architecture review returned `Needs rework`: content hashes cover a normalized view (CR → LF) the heading parser does not share, and a history file could be judged and then refused at write, so a normalization twin planted earlier became a verified head.
- Round 11 (`6517826`) fixed that test-first:
  - per-file refusals run before judging;
  - a refused file takes its whole history (a refused PDF takes its `.md`);
  - `history.yaml` is written last, only once its history has landed;
  - heads are judged in their normalized view;
  - imported paths drop `.` segments;
  - `sealedHead` requires strictly increasing versions.

  QA on round 10 returned `BLOCKED`:
  - `./` duplicate spellings of a history file (closed by round 11);
  - the sidecar guard trusting a rewritten `.md`.
- Round 12 (`3e56db7`) fixed those test-first:
  - sidecars are judged against the bytes on disk;
  - reads and erases measure names as the host file system does (NTFS: UTF-16 units).

  The architecture review returned `Needs rework`: the live document was split on LF alone while the sealed head was read in its normalized view, so a required section could be dropped across two imports; and when an imported `history.yaml` was refused, the one already on disk was left with the files that landed, a combination nothing judged.
- Round 13 (`c4eefd8`) fixed that test-first:
  - one line model (CR, LF and CRLF each end a line) for headings and sections;
  - an imported history is also judged under the `history.yaml` already on disk;
  - a missing sidecar is restored only with the bytes the sealed head records, and a `.pdf` beside an ordinary document is an ordinary file;
  - a refused document or PDF takes its history with it;
  - an imported PDF lands sealed in an encrypted vault (it landed as plaintext before this branch);
  - reads measure the `.md` file an id names.

  QA on round 12 returned `BLOCKED`. Its blocker was the lone-CR fence twin, which round 13 closed. It also reported non-blocking findings: forgotten documents in an export, replay cost, archive cascades, `./` history keys, quadratic collision planning, and error paths that leaked the vault path.
- Round 14 (`adcff0b`) fixed those test-first:
  - a forget stub (empty body) owes no required sections, so an enforced vault's own export round-trips;
  - `sealedHead` bounds replay work (text size × diffs);
  - a refused archived PDF no longer takes its history;
  - a never-sealed PDF node takes the sidecar its `.md` names;
  - imports keep `INDEX.md`/`README.md` names, key `./` histories by slug, plan collisions in linear lookups, and report vault-relative errors.

  The architecture review of round 13 returned `Needs rework`. The round-13 "companion PDF" exemption trusted an importable `.md`, so a retyped `.md` freed a pdf node's sidecar. Its check of the history already on disk also refused repairs of grandfathered documents, and judged members the disk might never hold.
- Round 15 (`3cf0b6e`) fixed that test-first:
  - PDFs are judged on bytes first, and the bytes a companion `.pdf` replaces are archived;
  - the on-disk history is judged only with hash-pinned members, and only when that changes its head;
  - a document's `.versions/` folder takes no nested paths;
  - unreadable version artifacts are corrupt history, never "missing";
  - a refused document takes its family;
  - forgotten PDF bytes are refused at any path;
  - one line model for frontmatter, headings, sections and links;
  - import verdicts move to their own module (`api/import-verdicts.ts`).

  The architecture review of round 15 returned `Needs rework`:
  - a forged forget-stub head excused every required section;
  - restoring a grandfathered document over itself was still refused;
  - kept `README.md`/`INDEX.md` names could write into another spelling on case-insensitive file systems.
- Round 16 (`51d69a7`) fixed that test-first:
  - a stub grants nothing as a baseline;
  - imported heads are judged as updates over the verified head here;
  - only `INDEX.md`/`README.md` are kept, refused beside another spelling;
  - unreadable on-disk histories refuse their set;
  - replay work is counted as it replays;
  - verify reports unreadable artifacts;
  - forgotten PDF bytes are refused under any name.

  QA on round 15 returned `BLOCKED`. Two of its blockers (stub baseline, legacy re-import) were closed by round 16. The other two were chunked PDF restores that stuck when the history was incomplete, and event-loop stalls of up to 8 s from replaying planted histories.
- Round 17 (`b02b408`) fixed those test-first:
  - sidecars are judged on the bytes on disk, so with none there a PDF lands in any chunk order;
  - one import's replays share a host-set budget (`limits.importReplayChars`, 512 Mi), refused whole and asked to split when over;
  - replays run one at a time and yield;
  - kept names are never renamed;
  - a file in the place of a `.versions/<doc>` folder is refused.

  **Known, not in this phase:**
  - Re-importing an encrypted vault's raw (still-encrypted) export over itself is refused under enforced rules, because the rules read ciphertext. Its fix is to judge imported encrypted text through storage.
  - One file with unparseable frontmatter breaks `context_list`/`context_search` for the whole vault.
  - An overwrite import can replace the nest checkpoint ledger.
  - The `.versions/<doc>/<file>` path grammar is still parsed in several modules.

  The architecture review of round 17 returned `Needs rework`:
  - jsdiff's position search for a hunk that does not fit was unbounded (seconds to hours from one patch);
  - a set re-sending an identical history skipped replaying its own version files;
  - an unparseable head was accepted as an import baseline;
  - a file named `.versions` could block a folder.

  It judged the round-17 sidecar reversal acceptable and the per-call budget sound.
- Round 18 (`aa6048d`) fixed those test-first:
  - every patch goes through `applyPatchBounded` (replay, reconstruct, held edits, suggestion approval);
  - a set that brings a version file is always replayed;
  - only a parsed head is a baseline;
  - `.versions` files are refused;
  - a `source` under `sources/` is no baseline;
  - the sealed bytes restore over a drifted sidecar;
  - kept-name twins use the file-system fold;
  - a forgotten version's text is refused under any name;
  - a test pins that the `.versions` path parsers agree.

  QA on round 17 returned `BLOCKED`, with a partial report:
  - the budget did not count reading and hashing (planted histories with junk lines: about 20 s and 3.5 GiB from a 738 KB request);
  - bulk publish (`context_import ids`) was unbudgeted;
  - an import could write the vault's own write lock.
- Round 19 (`7bd9575`) fixed those test-first:
  - reads, hashing and replay are charged to one budget per import call (verdicts and bulk publish), with a 64 Mi per-history read cap;
  - histories are read and replayed one at a time;
  - dot-named `.versions/` entries are refused.

  **Known, not in this phase (added):** publishing a large document with a long diff chain stalls the event loop for seconds even without rules (`reconstructFromHistory` plus `createPatch` in versioning). This predates the phase and is queued as its own task.

  QA and the architecture review re-run on `7bd9575`; their verdicts gate this phase.
- Round 20 (`264e855`), from the architecture review:
  - patch application priced per comparison;
  - artifact reads moved off the replay queue, size-capped (`sealedReaders`);
  - history reads capped at 16 MiB.
- QA round 19 (on `7bd9575`) returned `BLOCKED`. Its two blockers:
  - **B1:** a diff of added lines ahead of a context line that fits nowhere was walked at every position without being counted. A 3 KB diff stalled verify, reconstruct, updates and imports for about 19 s.
  - **B2:** an import could put a folder where a root ledger belongs (`context_history.yaml`, `context_latest.yaml`, `chain_events.yaml`), so every later checkpoint or forget failed with `EISDIR`.

  Round 21 (`7d7c175`) fixed both test-first:
  - hunks apply only where their header says;
  - root-ledger folders are refused, compared after folding;
  - reads are sized to the room left in the history's cap and the budget;
  - a bulk publish judges its documents in order, so the published prefix is the same on every run;
  - a document with no history is never cut short;
  - a `NaN` budget means the default.
- The architecture review of rounds 18–21 said `Needs rework`. Its findings:
  - **B1:** a hunk header pointing past the end of the text made the library copy without bound.
  - **M1:** the import readers dropped the read cap.
  - **M2:** "run it again to continue" was wrong in every mode.
  - **M3:** conforming documents were replayed for nothing.

  Round 22 (`4336ffe`) fixed those test-first:
  - headers are bounded and must be in order;
  - the room left is passed through every reader;
  - a document cut short is told to publish in a separate call;
  - a document that passes the full check is never replayed.

  It also:
  - reports a held edit or suggestion that no longer applies as stale;
  - removes the read timeout, so verdicts no longer depend on disk speed;
  - allows 4 bytes per character of room;
  - exports `structureReport` for judging a draft before saving it.

- QA round 21 (on `7d7c175`) said `BLOCKED`: the far-insertion hunk (fixed in round 22) and held edits after a frontmatter-only edit — listed live, never approvable, a second hold dropping the first. Round 23 (`366bd21`) makes such a hold stale in the listing, the proposal and approval alike, and gives reads five bytes per character of room (encrypted CJK measures 4.06).
- The architecture review of round 22 said **Approve with nits**. Round 24 (`1dec71d`) took the minors: the disk's head is rebuilt only when a verdict needs it, the per-file ceiling matches the room, clearer approval messages, tests that fail without their fixes, docs. Not taken: turning off the patch library's line-ending conversion (older histories may rely on it; the architect agreed).
- QA round 22 (on `366bd21`) said **PASS**, with non-blocking findings. Round 25 (`8a4cdfb`) fixed them: no process-wide read slots (four hung reads could stall other vaults), a restored history equal to the one on disk is rebuilt once, `applyStagedEdit` checks the body a held edit or suggestion proposed (a shifted patch on repetitive text could land on the wrong line), non-regular version files are refused unread, and a seeded patch round-trip property test.
- **The adversarial suite.** Every probe QA wrote in rounds 5–21 (242 probes, about 60 attacks) is now a committed test: `packages/engine/src/__tests__/structure-adversarial.test.ts` and `packages/mcp-server/src/__tests__/structure-adversarial.regression.test.ts`. Round 25 fixed three of its findings: an imported chain-event log under another spelling (`.Versions/…`) overwrote the forget log and so undid forgets; and two quadratic regexes (the JATS importer, MCP `list_documents`).
- The architecture review of rounds 23–25 said **Approve with nits**. Round 26 (`4c925d3`) took its minors — at most four histories judged at once per import, a failed rebuild not repeated, `isChainEventLog`, `applyStagedEdit` exported, the spec's staleness rule matching the code — and the two engine items the UX review asked for: a warning for a template whose required section is not a heading in its own body, and a clear message for an unclosed `{` in a name format.

- QA round 23 (on `8a4cdfb`) said **PASS**, with non-blocking findings in the import path that merges a chain-event log.
- Round 27 (`f9bb46e`) fixed the four known items the adversarial suite held open:
  - *s3enc / badfm / badsib* — a document whose frontmatter does not parse, or whose sealed bytes do not open, is skipped by listing, search and checkpoints, and named by verify (`unreadable_document`). A vault whose key is missing or wrong still refuses to read. An import refuses such a file.
  - *corrupt* — verify reports a `history.yaml` that is a folder or a link.
  - *obsid* — a bare id finds the document create made under `nodes/`.
- Round 28 (`e6db383`) fixed QA round 23's findings:
  - An imported forget is re-applied only to a copy holding content it erased. Before, it erased any document named by id, so a caller who could import could erase what it could not forget.
  - Imported forget records are logged as their own fields, in one write. An alias chain had expanded the log to 105 MB, and 5000 events took 338 s.
  - Version files are opened without blocking: a FIFO had hung verify, reconstruct and update.
  - Two more backtracking trims are now loops.

- QA round 24 said **BLOCKED** and the architecture review of rounds 27–28 said **Needs rework**. Five of the seven blockers came from rounds 27–28. From then on, by the user's stopping rule, only blockers were fixed. Round 29 (`7c651df`) fixed them, each with a test that fails on `e6db383`:
  - A file sealed under a key the config does not hold fails the read (`ForeignVaultKeyError`), never listing as empty. `encryptVault` will not create a new key over sealed files.
  - A checkpoint carries forward an unreadable document's last sealed entry.
  - `ctx verify` names `unreadable_document`.
  - Frontmatter of the wrong shape is one typed error (`FrontmatterShapeError`), and `tags: x` reads as a list.
  - An imported forget reaches a copy whose sealed versions hold the erased body. A reused event id with a different record is refused, and a versions-scoped record is logged, not applied.
  - `context_update` validates the id before reading.
  - A name format is at most 200 characters.
  - The changesets no longer claim that the forget gate authorizes anything.
- `5b95747` merged `development` (the engine 2.12.0 line). Six conflicts were resolved by keeping both sides.
- The re-checks found one new blocker, introduced by round 29's forget fix: finding an erased body in a copy's versions was unbounded work under the vault lock. Three commits closed it:
  - `e78f66c`: once per document per import, within the replay budget.
  - `34d5ee1`: one forward pass (`replayEveryVersion`), charged like the sealed-head replay. A planted 600-version history went from 35 s to 0.3 s.
  - `f5f11bd`: the per-import cache keyed by file identity (`documentFileKey`), not a per-record folder listing. 5,000 records against a 20,000-file folder went from 79 s to 4.2 s.
- QA round 25 on `f5f11bd` said **PASS**, and the architecture re-check said **Approve with nits**.

  **Known** (open as `it.fails` in the adversarial suite, with its repro):
  - *r23 outrange* — an import whose `history.yaml` equals the one on disk judges its version files by the head's rebuild, from the last keyframe. With overwrite, a file before that range (`v1.md` of a 12-version history) replaces the sealed file with other bytes, and verify then reports `content_hash_mismatch`. The same was true before structure rules. A check on bytes would refuse an encrypted vault's own re-import, so the fix needs the opened text.
  - *r27 B4 informed / poison* — a forged forget record carrying hashes any reader can obtain (a document's checksum) passes the pre-forget-copy check. One naming an absent path is logged with those hashes. Who may import forget records needs host authorization; the engine applies no forget tier.
  - *r27 M2* — an imported forget record with an unquoted timestamp is applied but not logged.

  **Recorded, not fixed** (non-blocking under the stopping rule):
  - A forget made elsewhere, applied to a copy whose versions differ, leaves this vault's own content hashes unrecorded. Verify then shows `unrecorded_tombstone`, and re-importing that vault's older `.versions/` files with overwrite brings the erased text back. This was true before for unedited copies.
  - A NUL in a document id leaks the vault path from get, delete, forget, versions, reconstruct and skill. `assertSafeDocumentId` does not refuse NUL.
  - Each imported forget record reads its document and history before any cache is consulted (records × history size). This was the same on `development`.
  - Two `.md` files hard-linked or symlinked to one inode share a cache key. That needs hand-made links.
  - On file systems that report no inode, the cache key falls back to the folder-listing lookup.
  - `replayEveryVersion` does not apply the `MAX_SEALED_ARTIFACT_BYTES` cap.
  - `context_update {id: "packs"}` is refused before the bare id resolves.
  - The changesets mark an API change as breaking under a minor bump.
  - A malformed imported `packs/*.yml` breaks `context_packs`, which was the same on `development`.
  - Community's `withDiscoveryCache` drops `onUnreadable`, so Community's verify won't name unreadable documents until it bypasses the cache for that call. Fix this with the engine pin bump.

  **Chunked imports.** The engine judges each imported history by what the nest will hold after the call: the call's files laid over what is already there, rebuilt and hash-verified. A document may arrive before or after its history, across calls. Within a history, a call must not bring `history.yaml` ahead of the keyframes and diffs it needs, since a history that does not rebuild and verify is refused. So the UI chunker (`ui/src/lib/api.ts`), which splits by bytes, should send each `.versions/<doc>/` folder's `history.yaml` last. Community's own staging (nest import, bundle restore, `context_sync_folder`) is designed to run under `skip` (§6), which leaves it unjudged. Until that flag is wired into Community's `opContext`, those imports are judged. The browser picker currently sorts `history.yaml` before `v*.md`, so a chunk boundary inside a `.versions/<doc>/` folder would get that history refused. Sort `history.yaml` last, or wire `skip`, as part of the Community phase.

| Suite | Kind | What it pins |
|---|---|---|
| `packages/engine/src/__tests__/structure-rules.test.ts` | unit | Compiling: tokens, regex safety (the grammar, repeated groups, lookaround, backreferences, length, linear-time matching of worst-case shapes, and a differential test against `RegExp`) and config errors naming the key. Paths and exemptions; closed vs open structure; implied ancestors; folder-name formats; literal-beats-placeholder precedence (including integer-like keys); types; file names; required sections (levels, case, CRLF, prose, code fences); grandfathering on update; delete guards; scaffold plans; audit; resolve and describe; `enforceStructure`. |
| `packages/engine/src/__tests__/structure-rules-ops.test.ts` | unit, through `createEngineApi` | Each write op refused with nothing written: create (folder, name, explicit id, sections, type, placeholder, held for review), update grandfathering, delete of a required file, import `files[]` and `documents[]`, import_pdf. Also: scaffolding (and no re-scaffold), report-only and absent rules, a bad rule refusing writes with `CONFIG_ERROR` while reads still work, the skip flag (and that it is unreachable from input), the `.context/` import refusal (path tricks included), the `context_structure` output, and `setStructure` (keeps other bytes, comments and CRLF; refuses invalid rules without writing; removes the blocks). |
| `packages/cli/src/__tests__/structure.regression.test.ts` | regression, built `ctx` | `ctx structure` (`--json`, `--folder`, `--report`, human output); `ctx add` refusals and template pre-fill; scaffolding; `ctx delete` guard; `CONFIG_ERROR`; `--json` parity between local and remote over the built MCP server; enforcement through a remote nest. |
| `packages/mcp-server/src/__tests__/mcp-server.regression.test.ts` (structure block) | regression, built MCP server | `context_structure` in the tool list; catalog `context_create` refusals; the deprecated `create_document` / `update_document` cannot bypass the rules; `context_import` cannot rewrite `.context/config.yaml`. |
| `plugins/__tests__/core.unit.test.ts` (session-start, structure rules) | unit, fake `exec` | Blueprint only for the pinned or working-directory vault; silent when there are no rules or `ctx` is older; capped output. |
| `packages/cli/src/__tests__/remote-capabilities.test.ts` (remoteAdd, structure template) | unit, fake remote | Template pre-fill only when the nest advertises `context_structure`; an explicit body wins. |

### 10.2 Community API phase — tests to write first

- `test/structure-routes.test.ts`, using `setupTestEnv` / `createTestApp` / `registerUser`:
  - **Reading:** `GET /nests/:id/structure` for every role, with `folder`, `report` and `yaml`.
  - **Saving:** `PUT` succeeds only for owners and admins (`canManageStewards`). It is refused for editors, reviewers, viewers and nest-scoped keys, whatever the key's role.
  - **Invalid rules:** a rule that doesn't compile is refused with 400 `{ error, fieldErrors }`, keyed by the rule key, and nothing is written.
  - **Storage:** rules land in the nest's `.context/config.yaml` with its other keys and comments kept. An imported nest with no `config.yaml` can save rules too (engine prerequisite, §6.1).
  - **Audit:** a `structure_changed` activity entry records the actor, the summary and the before and after rules.
  - **The check API** (`POST /structure/check`):
    - saved rules at read tier, including for viewers (the middleware exemption);
    - draft rules at manage tier only;
    - `fieldErrors` and `warnings`, including a required section that is not a heading in its template;
    - per-test results, with `slug` matching Community's `slugify`;
    - `scaffold` for `folders`;
    - `report` judged against the draft;
    - the 50-test and 256-rule caps.
- `test/structure-enforcement.test.ts`:
  - REST create, update and delete are refused with **400** (never 500), and bulk publish reports the refusal per row;
  - `moveNode` into a disallowed folder or name format;
  - `createEmptyFolder` refused, and scaffolding on success;
  - `deleteFolder` removes a folder that holds required files;
  - a held agent write (push confirmation) is refused when confirmed;
  - the annotations projection and import staging (nest import, bundle restore, folder sync) pass with the skip flag, and the bundle's `.context/config.yaml` lands.
- **MCP:** `context_structure` on the per-nest and server-level endpoints. Refusals carry their code in `structuredContent`. `npm run lint:mcp-schemas` stays green, since the schema comes from the engine catalog.

### 10.3 Community UI phase — tests to write first

- **Unit:**
  - the `nest-pages` invariants include `structure` (update the hard-coded list in `nest-pages.test.ts`);
  - reader view hides the page;
  - `structure-draft.ts` round-trips every rule shape: the API shape becomes form rows and comes back unchanged.
- **Playwright** (`tests/`):
  - **Owner, building:** builds `clients/{client}/meetings` in the path builder, gets a field error from the check API for a bad regex, fixes it, and saves. The toast appears and the rule is listed.
  - **Owner, enforcing:** turns Enforce on, sees the confirmation with the count of existing items, confirms, and the header shows "Enforced".
  - **Entry points:** the folder row's Ruler button opens the page with that folder's rule selected, and "Structure rules" appears in the nest ⋯ menu for owners only.
  - **Editor, new document:** it opens pre-filled from the template, offers only the allowed types, and shows the format hint and the live "Saved as …" check. A conforming title saves; a refused save shows the server's message.
  - **New folder:** the dialog shows the format hint, refuses `clients/acme`, and previews "Also creates: …" for `clients/acme-042`.
  - **Compliance:** the tab lists grandfathered content, and "Create from template" and "Create folder" clear their rows.
  - **Read-only:** viewers and editors see the page with every control disabled and the "managed by owners and admins" note.
  - **Unsaved changes:** leaving the page asks for confirmation.

### 10.4 Regression gate

Before any push, both repos run their full suites:
- ContextNest: `pnpm lint`, `pnpm test`, `pnpm test:regression`, `pnpm plugins:check`.
- Community: `npm run typecheck`, `npm test`, `npm run lint:mcp-schemas`, and `npm run test:playwright` when the UI changed.

Then the QA agent repeats the run independently and attacks the change.

## 11. Risks and limitations

- **Mixed engine versions.** An engine older than phase 1 strips the new keys, and `ctx init` re-init rewrites the config. On such a version, rules are advisory only.
- **On-disk edits.** Files added straight to disk, outside every write surface, cannot be refused. They show up in the compliance report.
- **No rename.** A document whose leaf doesn't fit a destination's `file_name` cannot be moved there yet. The workaround is to create a conforming document and delete the old one, which loses its history; a rename op fixes this.
- **Config history.** `config.yaml` is not versioned by the engine. Rule changes are audited in Community's activity log only.

## 12. Out of scope / later

- A rename operation, so that a move can fix a non-conforming name.
- Auto-naming (the server filling `{date}` or `{n}`).
- Per-role bypass.
- Review-gated rule changes.
- `ctx structure set` against remote nests. For now, local rules are edited in `config.yaml` and Community rules through the UI or `PUT`.
- A YAML editor in the UI.
- Generating a blueprint from the existing folder tree.
- A dry-run impact preview before saving rules. Grandfathering means a save never breaks existing content.
