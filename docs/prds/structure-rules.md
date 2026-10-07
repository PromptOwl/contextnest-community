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
- **Exempt paths — only at the vault root.** `packs/`, `_suggestions/`, the vault's own `CONTEXT.md`, and `sources/` for `type: source` nodes. Their look-alikes (`nodes/packs/`, `nodes/context`, dot-folders, an `INDEX` id) are ordinary paths: exempting them let any writer get around closed mode. An id is never extension-stripped. In a structured vault only `nodes/` holds content folders, so root-level folders such as `assets/` are not judged.
- **Segments.** A pattern segment is either a literal (`meetings`) or a placeholder (`{label}`).
- **Precedence.** When several patterns match, they are compared segment by segment, and at the first difference a literal beats a placeholder. Declaration order is not used, because JavaScript objects list integer-like keys (`"2024"`) first.
- **Ancestors.** Ancestors of a declared pattern are allowed as folders. `clients/{client}/meetings` implies `clients` and `clients/{client}`. An ancestor holds documents only if it is declared itself.
- **Defaults.** No `types` means any accepted type. No `file_name` means any name.
- **`closed`.**
  - When off (the default), rules apply only where a pattern matches, and everything else is free.
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
- It is matched against the **slugified** name. Names are always lowercase kebab-case, because titles and folder names are slugified before they become ids. The UI says so wherever a regex is entered.
- **Safety: a whitelist, not a blocklist.** Rules are written by nest owners on a shared server, so a regex must not be able to stall the process. QA and the architecture review both broke an earlier blocklist (bounded `{m,n}` repetition, `|` chains, a `[^]` hiding a nested group). A regex is now accepted only if it stays inside this grammar; anything else is refused with `CONFIG_ERROR` naming the key:
  - literals, the escapes `\d \w \s \D \W \S` and escaped punctuation, `[classes]` (parsed the way JavaScript parses them), `.`, `^` and `$`;
  - quantifiers on single atoms only, at most 3 of them variable-width (`*`, `+`, `?`, `{m,}`, `{m,n}`);
  - `( )` / `(?: )` groups that are never quantified, with at most 4 `|` in the whole regex;
  - at most 200 characters.

  No repeated groups means no nested repetition, so a match tries at most ~n² splits per alternative. A name longer than 128 characters is refused without running the pattern. Token patterns follow the same budget: at most 3 variable-width tokens (`{slug}`, `{n}`), never two side by side.

**File names are checked on the id's leaf, not the title.**

- The leaf is `slugify(title)` unless the caller passes an explicit id.
- A title with no ASCII letters or digits gets a generated slug that can never match a name rule. The refusal message says so.
- Leaves listed under the folder's `files:` are always allowed, whatever `file_name` says.

### 3.4 Templates, required sections, required files and subfolders

- **Templates.** `folders.<pattern>.template` names an entry in `templates:`.
  - Every surface offers the template body as the starting content of a new file in that folder: the UI editor, `ctx structure --folder`, and `context_structure`.
  - The engine does **not** silently fill empty content, except when it scaffolds a required file.
- **Required sections.** `templates.<name>.required_sections` lists headings (any level) that a document in that folder must contain.
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
| `TYPE_NOT_ALLOWED` | the node type is not in the folder's `types` |
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
          violations?: [{ code, path, rule, message }] }                        // when report: true
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

  | Op | Where |
  |---|---|
  | `context_create` | before the write at :515 |
  | `context_update` | against `existing` (:561), which is already the pending proposal when the edit is held for review |
  | `context_import` | both paths: `files[]` after `planImportPaths` (:1146), and `documents[]` |
  | `context_import_pdf` | — |
  | `context_delete` | required-file guard |
  | deprecated mcp-server `create_document` / `update_document` | `packages/mcp-server/src/index.ts:922` and `:1121`; one call each, because they write storage directly |

- **Security fix.** `context_import`'s `files[]` refuses paths under `.context/`. Today `overwrite: true` lets any caller rewrite `config.yaml`, which means the structure rules *and* the review gate. No write op accepts a document id under `.context/` either (case-insensitive; Windows trailing dots and spaces ignored).
- **Shared IO helpers** (`structure-store.ts`, exported): `enforcedStructure(storage)` (the rules only when enforced), `missingFolders(storage, id)` and `scaffoldFolders(storage, rules, created)` (best-effort scaffolding), and `assertStructureUpdate(storage, id, beforeRaw, afterRaw)`. Approvals, `ctx pull`, the legacy MCP tools and Community's own write paths use these, so nobody re-implements scaffolding or the enforce gate.

- **Skip flag.** A new `OperationContext.structure?: "skip"`. It is set only by trusted binding code for system writers (see §6) and is never read from operation input. Under it the rules are not enforced, and `context_import` may land `.context/` files: that is how a bundle restore brings the source nest's `config.yaml`, rules included.

- **New op and CLI.** Add `context_structure` in `api/core.ts`, the `ctx structure` command in `cli/src/index.ts`, and `remoteStructure` in `cli/src/remote.ts`.

- **Plugin.** The changes are listed in §4.

- **Spec.** Add a §11.1.1 subsection with paragraphs for `structure`, `folders` patterns and formats, `templates`, and required and scaffolded structure. Add a §17 changelog line.

- **Mixed versions.** An older engine strips the unknown keys, so there the rules are advisory. Release notes must say so.

## 6. Community phase

- **Engine pin.** Bump `@promptowl/contextnest-engine` to the release that carries this feature.

- **REST:**

  | Route | Tier | Purpose |
  |---|---|---|
  | `GET /nests/:id/structure?folder=&report=1` | read | The `context_structure` binding: rules, the resolved rule and template for a folder, and the compliance report. |
  | `PUT /nests/:id/structure` | manage (`canManageStewards`, `src/governance/stewardship-service.ts:822`) | Saves rules via the engine's `setStructure` and writes an activity-log entry (who, when, what changed). |
  | `POST /nests/:id/structure/check` | read; manage when `rules` is sent | The UI's validation API; see below. |

- **`POST /nests/:id/structure/check`.** The UI contains no engine code: no matcher, no token logic, no regex. Every check is a server call, debounced to about 300 ms.

  ```text
  body:     { rules?, tests?: [{ folder, title?, name?, type? }] }
  response: { errors: [{ key, message }], results: [{ ok, slug, violations }] }
  ```

  - **Without `rules`,** the tests run against the saved rules. The new-document and new-folder forms use this: does this folder, title and type fit, and what slug does the title become?
  - **With `rules`,** the draft is compiled, regex safety included. `errors` points at the offending key, and the tests run against the draft. The rule editor uses this for its "Try" boxes and field errors before saving.
  - On the server it calls the engine's exported `compileStructure`, `checkDocument` and `checkFolder`, and Community's own `slugify` for `slug` (it is the function that builds Community's ids, so it is what the server will produce). The UI therefore shows exactly what the server will enforce.

- **Write paths that don't go through an engine op** call the engine's exported `enforcedStructure`, checkers, `missingFolders` and `scaffoldFolders` directly — never a copy of them:
  - `moveNode` (`src/nodes/service.ts:2571`) checks the destination and scaffolds any new folder. The move keeps the file's leaf, so a non-conforming name cannot move into a folder with a name rule until a rename op exists (§12).
  - `createEmptyFolder` (:1078) checks the folder and scaffolds its required children.
  - `deleteFolder` (:2972) first calls `checkDeleteFolder` on the folder itself (a required subfolder cannot go on its own), then passes the skip flag for its own children, so the required-file guard does not block deleting the whole folder.

- **Skip flag** (passed through `opContext`, `src/nodes/engine.ts:430`, the same way `limits` travels). It is set only for system writers that derive content rather than author it:
  - the annotations projection (`nodes/<base>--annotations`);
  - import staging (`stageImportedFiles`, `src/nodes/service.ts:1840`), which covers nest import, bundle restore and `context_sync_folder`. These bring a whole vault, rules included, so what they bring is reported, not refused.

  Revert and agent-activity undo stay enforced.

- **Error mapping.** `createNodeOnce` maps the engine's `VALIDATION_FAILED` to `ValidationError` (400), the way `pdfEngineError` does (`src/nodes/service.ts:439`).
  - Today an engine validation failure on that path surfaces as a 500, and bulk publish (`src/nodes/publish-apply.ts:176`) flattens it to "Could not create this document".
  - Held agent writes go through the same path when they are confirmed.

- **UI:**
  - a new nest page, `ui/src/pages/nest/structure/` (`meta.ts`, `page.tsx`, plus a `viewPage` union value in `ui/src/lib/nest-pages.ts:37`);
  - template pre-fill and validation in the create flows (`ui/src/components/DocumentEditor.tsx`, and the new-folder dialog in `ui/src/components/NestView.tsx`).

  The flow is in §7.

- **Docs.** `API.md` (the three routes and the refusal messages) and `STEWARDSHIP.md` (who edits rules).

## 7. How a user adds rules in the UI

**Who.** Nest owners and admins (`canManageStewards`) can edit. Everyone else sees the same page read-only, with the note "Rules are managed by owners and admins". Editors use it to learn where things go.

**Where. There are two ways in:**

1. **Nest → Structure** in the nest navigation, next to Board, Graph, Definitions and Workflows.
2. **From the folder itself.** The `⋯` menu on any folder in the Documents tab (`FolderTree.tsx`) has **"Rules for this folder…"**. It opens the Structure page with that folder's rule selected, or creates one for that exact path.

**Empty state.** "No structure rules yet. Rules decide which folders can exist, what goes in them, how files are named, and which templates they start from." → **[+ Add folder rule]** **[+ Add template]**

**Step 1 — Add a folder rule.** Click **+ Folder rule**, or **+ Subfolder** on an existing rule, which pre-fills the parent. A path builder appears with one row per level:

```text
Folder path
  [clients        ]  Fixed name
  [client         ]  Any name ▾   Format: [Custom regex ▾]  /[a-z]+-[0-9]{3}/
                                   Try: [acme-042] ✓   [acme] ✗ must match /[a-z]+-[0-9]{3}/
  [+ add level]
→ Pattern: clients/{client}
```

- Each level is a **Fixed name** or **Any name**, with a label.
- An Any-name level takes a format: Any, Year, Date, Number or **Custom regex**.
- The **Try** box calls `POST /structure/check` with the draft rules. A regex the server refuses (nested quantifier, lookaround, too long) is flagged right there, with the server's reason.

**Step 2 — Say what can go in it.** The selected rule's right-hand pane:

```text
clients/{client}/meetings
─ What can be added here ─────────────────────────────
  [✓] Document  [ ] Snippet  [ ] PDF  [ ] Prompt  …     ( ) Nothing directly in this folder
─ File names ─────────────────────────────────────────
  (•) Pattern  [Date] [-] [Title]   + Year  + Number  + text      ( ) Custom regex  ( ) Any
      Example: 2026-10-07-kickoff-with-acme
      Try a title: [Kickoff with Acme] ✗ becomes "kickoff-with-acme" — must start with a date
─ Starts from template ───────────────────────────────
  [meeting-note ▾]   (+ New template…)
─ Required ───────────────────────────────────────────
  [✓] Always create this folder with its parent       (fixed-name folders only)
  Required files:  [overview] from [client-overview ▾] type [Document ▾]  [×]   [+ Add file]
```

"Try a title" shows the slug the server derives from the title, which makes it clear that names are always lowercase kebab-case.

**Step 3 — Add templates.**
- In the **Templates** tab, click **+ Template**, then enter a name and the body in a markdown editor.
- The body's headings appear as chips. Clicking a chip marks that section **required**, shown with a lock.
- Templates can also be created inline from "+ New template…" in Step 2.

**Step 4 — Choose how strict.** The page header has two switches:
- **Closed structure** ("Only folders in this blueprint are allowed") is off by default.
- **Enforce** is off by default; off means report-only.

**Step 5 — Save.** Save sends `PUT /nests/:id/structure`.
- The server re-validates, and any error appears inline at the field it names.
- An activity-log entry records the change.
- The **Compliance** tab badge then shows how many existing documents and folders don't fit.

**Step 6 — Clean up, then enforce.**
- The **Compliance** tab groups violations by code. Each row offers **Open** and **Move…**; a missing required file or folder also offers **Create from template**.
- Turning **Enforce** on asks for confirmation: "12 existing items still don't fit. They stay editable, but new documents, moves and imports that break these rules will be refused for everyone: editors, agents and `ctx`." → **[Enforce rules]**

**Changing or removing rules.** Click a rule in the tree to edit it. Its `⋯` menu has **Remove**, which asks for confirmation when the rule has subfolder rules. Because existing content is grandfathered, saving a change never breaks what is already there.

**Where editors meet the rules:**

- **New document** in a folder that has rules:
  - The editor opens pre-filled from the folder's template (`GET /structure?folder=`).
  - The type picker shows only allowed types.
  - A hint under the title shows the name format, for example "File names here: `{date}-{slug}` — start the title with a date".
  - Title, folder and type are checked as you type (`POST /structure/check`). If a refusal still happens on save, its message is shown verbatim.
- **New folder:** the dialog shows the expected format, validates the name the same way, and previews what will be scaffolded ("also creates meetings/, contracts/, overview").
- **Move:** a refused move shows the server's message.

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
2. **Community API and enforcement:** engine bump, the three REST routes, the MCP tool, `moveNode`/`createEmptyFolder`/`deleteFolder` checks, the skip flag, and the error mapping.
3. **Community UI:** the Structure page (Blueprint, Templates and Compliance tabs) and the create-flow integration.

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

### 10.1 Engine phase (ContextNest) — done

Round 1 (`9c8c3a3`) passed every suite but QA and the architecture review returned `BLOCKED` / `Needs rework` (ReDoS bypasses, closed-mode bypass through system-path look-alikes, legacy configs refusing writes, a stranded write when scaffolding failed, unenforced paths: deprecated `delete_document`, `ctx pull`, approvals). Round 2 (`e81d3f1`) wrote a failing test for every finding first, then fixed them; both reviewers re-run against it.

| Suite | Kind | What it pins |
|---|---|---|
| `packages/engine/src/__tests__/structure-rules.test.ts` | unit | Compiling: tokens, regex safety (nested and alternating repetition, lookaround, backreferences, quantifier budget, length) and config errors naming the key. Paths and exemptions; closed vs open structure; implied ancestors; folder-name formats; literal-beats-placeholder precedence (including integer-like keys); types; file names; required sections (levels, case, CRLF, prose, code fences); grandfathering on update; delete guards; scaffold plans; audit; resolve and describe; `enforceStructure`. |
| `packages/engine/src/__tests__/structure-rules-ops.test.ts` | unit, through `createEngineApi` | Each write op refused with nothing written: create (folder, name, explicit id, sections, type, placeholder, held for review), update grandfathering, delete of a required file, import `files[]` and `documents[]`, import_pdf. Also: scaffolding (and no re-scaffold), report-only and absent rules, a bad rule refusing writes with `CONFIG_ERROR` while reads still work, the skip flag (and that it is unreachable from input), the `.context/` import refusal (path tricks included), the `context_structure` output, and `setStructure` (keeps other bytes, comments and CRLF; refuses invalid rules without writing; removes the blocks). |
| `packages/cli/src/__tests__/structure.regression.test.ts` | regression, built `ctx` | `ctx structure` (`--json`, `--folder`, `--report`, human output); `ctx add` refusals and template pre-fill; scaffolding; `ctx delete` guard; `CONFIG_ERROR`; `--json` parity between local and remote over the built MCP server; enforcement through a remote nest. |
| `packages/mcp-server/src/__tests__/mcp-server.regression.test.ts` (structure block) | regression, built MCP server | `context_structure` in the tool list; catalog `context_create` refusals; the deprecated `create_document` / `update_document` cannot bypass the rules; `context_import` cannot rewrite `.context/config.yaml`. |
| `plugins/__tests__/core.unit.test.ts` (session-start, structure rules) | unit, fake `exec` | Blueprint only for the pinned or working-directory vault; silent when there are no rules or `ctx` is older; capped output. |
| `packages/cli/src/__tests__/remote-capabilities.test.ts` (remoteAdd, structure template) | unit, fake remote | Template pre-fill only when the nest advertises `context_structure`; an explicit body wins. |

### 10.2 Community API phase — tests to write first

- `test/structure-routes.test.ts`, using `setupTestEnv` / `createTestApp` / `registerUser`:
  - `GET /nests/:id/structure` for every role;
  - `PUT` allowed only for owners and admins (`canManageStewards`), and refused for editors, reviewers, viewers and nest-scoped keys;
  - an invalid rule is refused with 400 naming the key, and nothing is written;
  - the activity-log entry is recorded;
  - `POST /structure/check`: saved rules at read tier, draft rules at manage tier only, field errors, per-test results, and `slug` matching Community's `slugify`.
- `test/structure-enforcement.test.ts`:
  - REST create, update and delete are refused with **400** (never 500), and bulk publish reports the refusal per row;
  - `moveNode` into a disallowed folder or name format;
  - `createEmptyFolder` refused, and scaffolding on success;
  - `deleteFolder` removes a folder that holds required files;
  - a held agent write (push confirmation) is refused when confirmed;
  - the annotations projection and import staging (nest import, bundle restore, folder sync) pass with the skip flag, and the bundle's `.context/config.yaml` lands.
- MCP: `context_structure` on the per-nest and server-level endpoints. Refusals carry their code in `structuredContent`. `npm run lint:mcp-schemas` stays green, since there is no inline schema.

### 10.3 Community UI phase — tests to write first

- Playwright (`tests/`):
  - an owner builds a rule on the Structure page, a field error comes from the check API, and the rule saves;
  - an editor's new document is pre-filled from the template and gets a live format hint and a refusal message;
  - the new-folder dialog previews the scaffold;
  - the Compliance tab lists grandfathered content and "Create from template" works;
  - viewers see the page read-only.
- `pages.test.ts` / `nest-pages` invariants cover the new page's `meta.ts`.

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
