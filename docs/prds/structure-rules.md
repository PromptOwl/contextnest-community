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
- A rename operation. That is a separate follow-up; see §11.
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

Existing configs stay valid. A `folders:` entry that has only `description` and `template` is a literal pattern with no constraints.

### 3.2 Paths and patterns

- **The path being checked.** It is the document id with an optional leading `nodes/` removed. This is the same rule Community's `folderToSegments` applies, and it does not depend on whether the vault uses the structured or the Obsidian layout.
- **Exempt paths.**
  - `sources/` is exempt **only for `type: source`** nodes. A blanket exemption would let an explicit id such as `sources/x` bypass every rule.
  - `packs/`, `.versions/`, `_suggestions/`, `INDEX.md`, `context.md` and `context.yaml` are always exempt.
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
- **Safety.** Rules are written by nest owners on a shared server, so a regex must not be able to stall the process. Every regex is compiled when the rules are saved and again when they are loaded. It is refused with `CONFIG_ERROR`, naming the key, if:
  - it is longer than 200 characters;
  - it uses backreferences or lookaround;
  - it nests quantifiers (star height > 1, the `safe-regex` test); or
  - `new RegExp` throws.

  Inputs are already capped at 100 characters per path segment. Together these bound backtracking.

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
  - Required files are written as **drafts** from their template.
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
- **Delete** of a required file or folder on its own is refused ("overview is required in clients/acme — delete the folder instead"). Deleting the whole parent folder is allowed.
- **Grandfathering.** A document that broke the rules before they were saved stays readable and editable. Nothing new lands in the wrong place, but nothing old is locked. `MISSING_FOLDER` and `MISSING_FILE` on folders that already existed are report-only, and the Compliance list offers to create them.

With **`enforce: false`** (the default), every rule is **report-only**. Violations appear in the compliance report and nothing is refused. This is the rollout step.

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
          resolved?:  { …the rule governing `folder`, with its template body… },   // when folder is given
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
  - `checkCreate`, `checkUpdate(existing, next)` and `checkDelete` return violations.
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

- **Security fix.** `context_import`'s `files[]` refuses paths under `.context/`. Today `overwrite: true` lets any caller rewrite `config.yaml`, which means the structure rules *and* the review gate.

- **Skip flag.** A new `OperationContext.structure?: "skip"`. It is set only by trusted binding code for system writers (see §6) and is never read from operation input.

- **New op and CLI.** Add `context_structure` in `api/core.ts`, the `ctx structure` command in `cli/src/index.ts`, and `remoteStructure` in `cli/src/remote.ts`.

- **Plugin.** The changes are listed in §4.

- **Spec.** Add §11.1 paragraphs for `structure`, `folders` patterns and formats, `templates`, and required and scaffolded structure. Add a §17 changelog line.

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
  - On the server it calls the engine's exported `compileStructure` and `checkCreate`, and Community's own `slugify` for `slug`. The UI therefore shows exactly what the server will enforce.

- **Write paths that don't go through an engine op** call the engine's exported checker and scaffolder directly:
  - `moveNode` (`src/nodes/service.ts:2571`) checks the destination and scaffolds any new folder. The move keeps the file's leaf, so a non-conforming name cannot move into a folder with a name rule until a rename op exists (§11).
  - `createEmptyFolder` (:1078) checks the folder and scaffolds its required children.
  - `deleteFolder` (:2972) passes the skip flag for its own children, so the required-file guard does not block deleting the whole folder.

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

1. **Engine (upstream PR, minor release):** schema, `structure.ts`, `setStructure`, enforcement and scaffolding in the executors, the `.context/` import fix, the `context_structure` op, `ctx structure`, the plugin changes, and the spec text.
2. **Community API and enforcement:** engine bump, the three REST routes, the MCP tool, `moveNode`/`createEmptyFolder`/`deleteFolder` checks, the skip flag, and the error mapping.
3. **Community UI:** the Structure page (Blueprint, Templates and Compliance tabs) and the create-flow integration.

Each phase is shippable on its own:
- After phase 1, local vaults and the OSS MCP server have rules, edited by hand in `config.yaml`.
- After phase 2, Community nests enforce rules set via the API.
- Phase 3 adds the owner-facing editor.

## 10. Risks and limitations

- **Mixed engine versions.** An engine older than phase 1 strips the new keys, and `ctx init` re-init rewrites the config. On such a version, rules are advisory only.
- **On-disk edits.** Files added straight to disk, outside every write surface, cannot be refused. They show up in the compliance report.
- **No rename.** A document whose leaf doesn't fit a destination's `file_name` cannot be moved there yet. The workaround is to create a conforming document and delete the old one, which loses its history; a rename op fixes this.
- **Config history.** `config.yaml` is not versioned by the engine. Rule changes are audited in Community's activity log only.

## 11. Out of scope / later

- A rename operation, so that a move can fix a non-conforming name.
- Auto-naming (the server filling `{date}` or `{n}`).
- Per-role bypass.
- Review-gated rule changes.
- `ctx structure set` against remote nests. For now, local rules are edited in `config.yaml` and Community rules through the UI or `PUT`.
- A YAML editor in the UI.
- Generating a blueprint from the existing folder tree.
- A dry-run impact preview before saving rules. Grandfathering means a save never breaks existing content.
