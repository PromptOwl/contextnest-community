# @promptowl/contextnest-community

## 1.29.1

### Patch Changes

- d7e4b68: Postgres servers whose `runs` table predates run claiming no longer crash at boot with `column "claimed_by" does not exist`; the migrations now add the missing claim columns.

## 1.29.0

### Minor Changes

- 07b63ef: Agent read log: the activity log now answers "what did agent X read, and which version did it see".

  - **Recorded where it wasn't.** An agent's MCP `context_search` — its most common read — was never recorded (the hits come back under `results`, which the recorder didn't look at). Now it is, along with `context_table_query`, REST `/table-query`, and historical version fetches (`GET …/nodes/:id/versions/:version`).
  - **Which version.** Read and retrieval rows carry the version the caller was served. Under stewardship an agent is given the approved version, and that is what the row records; with the versioned history that rebuilds exactly what the agent saw. A new version is a new row (it's part of the throttle key).
  - **Which agent.** REST reads now carry the agent the API key's label names (the same derivation writes already used), and Hootie's retrievals are attributed to `hootie`. `GET /nests/:id/activity-log?agent=<name>` filters to one agent; the Activity panel has an Agent filter.
  - **On by default, owner-only off.** New nest setting `access_log_enabled` (default on). Any nest admin may turn it on; only the owner or server admin may turn it off. Shown in nest Settings.
  - Recording stays fire-and-forget and never fails a read; the inserts are now one multi-row statement per call. Only ids and versions are stored — never content or what was searched.

  Migration `050_agent_read_log`: `node_access_events.version` and `.agent` (indexed, backfilled from `client_json` on SQLite), `nests.access_log_enabled`.

- 6679fd0: **Board: swimlanes, group by assignee or priority, done columns, and assigned-to-you in My Work.**

  - **Columns by Assignee or Priority.** Dragging a card across reassigns it or changes its priority, the way Linear's group-by works. "Unassigned" and "No priority" are always there as drop targets. "+ Add task" in a column sets that column's value. On an assignee board you can add a column for someone on the nest who has nothing assigned yet.
  - **Swimlanes** by assignee, priority or parent, on any grouping. Lanes collapse. Dragging into another lane updates that field in the same write as the column move. "+ Add task" inside a lane puts the new card in that lane.
  - **Done columns.** A nest admin marks a tag column as "done" with the check on its header; `done` is marked by default. A task moved into a done column gets a `completed_at` timestamp, and one moved out is reopened. Done cards show a green check and "done 2h ago". Sub-item chips show progress ("2/5"). A **Completed** display option shows completed cards from the past week or month, all of them, or none.
  - **Assigned to you in My Work**, across nests, soonest due first. When someone assigns you a card you get a notification, unless you assigned yourself.
  - Setting a field inline on a governed document (priority, assignee, due) now asks first, the same as dragging one.

- 5c67fc5: Licence features: enterprise capabilities are now unlocked by named features from PromptOwl, not by the licence tier.

  PromptOwl's licence console sets a licence's tier and can grant or revoke individual features on it; the licence check now returns the effective list as `features`, and this server gates on it (`hasEntitlement("<feature>")`). The first feature is `hootie_branding` (custom assistant name and branding): an Enterprise licence gets it by default, and PromptOwl can also grant it to another licence or revoke it from an Enterprise one. The list is cached with the rest of the licence (new `license_cache.features_json` column, migration `048_license_cache_features`), so an outage keeps the same features. A PromptOwl that sends no `features` falls back to the tier defaults, so existing Enterprise licences behave exactly as before. A suspended, invalid or expired licence unlocks nothing.

- 110496e: **Models run on PromptOwl credits unless the licence allows your own key.** Hootie and workflow agent runs now take their model credential from one place. With the `byok` licence feature (Enterprise), they use a nest's own `ANTHROPIC_API_KEY` first, then the server's, as before. A key and its `ANTHROPIC_BASE_URL` are always taken together from the same place, so a nest that sets only a base URL never receives the server's key. Without it, they use the PromptOwl model gateway that the licence check provides, metered in PromptOwl credits, and a stored own key is ignored (kept, not deleted). Saving an own key or gateway URL in Settings, or a model key in a nest's env, is refused without `byok` (`403`, Settings answers `code: "byok_required"`); clearing one is always allowed. Hootie's default model is now `claude-sonnet-5`, the efficient default the pricing spec calls for.
- c8721dc: **The server now knows its pricing plan.** The license check reads the plan PromptOwl assigns to the key (Free, Trial, Self-Hosted or Enterprise) and its limits: billed users, Account Owners, and subscribers (editors). A missing field takes the plan's default, and a key with no plan, or no license at all, runs as Free (10 users, 1 Account Owner, no subscribers). The seat limits and model-key rules below are enforced from it.

  **Model gateway key, cached encrypted.** When PromptOwl issues the license a LiteLLM key for running models on PromptOwl credits, the server keeps it encrypted in the license cache (new `license_cache.gateway_json` column, migration `049_license_cache_gateway`) and in memory. It is never part of any API response, and it is dropped as soon as the license stops being valid.

- 4df2fae: **Seat limits follow the pricing plan.** Each person now bills once, at their highest role on any nest: nest owners, admins, reviewers and server admins (Account Owners) are users; editors are subscribers; everyone else is a free viewer. A role change that would take the server past its plan is refused with `402` and `{ code: "plan_limit", limit, max }` — making someone a nest owner, admin, reviewer or editor (collaborator, steward, grant, or a team shared onto a nest), and adding a superadmin past the plan's Account Owner count. A new superadmin is also a billed user, so the user cap applies to them too. Free allows 10 users, 1 Account Owner and no editors.

  Nothing is taken away: signing up and inviting are never refused, viewers are always free, demotions always work, and a server already over its plan keeps everyone it has. A document's creator being made its reviewer does not count as a reviewer seat.

  The license check now reports billed users and subscribers instead of every account, and `GET /admin/license` returns the plan, the subscriber count and cap, and the Account Owner cap alongside the user seats.

- 6a277a4: **Plan limits and own model keys in the UI.** Settings → License shows the pricing plan, users and editors against the plan's caps, the Account Owner cap, and a **Manage plan** button that opens this key's page on PromptOwl (`GET /admin/license` now returns `manage_url`, which carries only the key's last four characters). When a role change is refused because of the plan (`402 plan_limit`), the dialog shows why and admins also get a prompt to manage their plan. Without the `byok` licence feature, Settings shows that models are supplied by PromptOwl on the plan's credits in place of the Anthropic key and gateway fields (a stored key can still be cleared), and the workflow run-key prompt no longer asks for a key the server would refuse. `/health` and `/admin/settings` report `byok_available`.
- 4b98af9: **Licensing is now a private conversation with the admin, not something the whole team runs into.**

  **Seats are reported to PromptOwl, never enforced.** Every license check (startup plus every 60s) now sends the server's user and nest counts, its version and `PUBLIC_BASE_URL` alongside the key. That is the head-count the license is billed on, and PromptOwl uses it to follow up about seats. It is part of validation, so it is sent even with `TELEMETRY_ENABLED=false`, and it never carries content. Going over the licensed seats blocks nobody. The admin sees a friendly note ("You have 34 people on a 30-seat license. Everyone can keep working…").

  **A lapsed license makes the server read-only instead of locking everyone out.** Before, a revoked or deactivated key wiped every session, deleted the stored key, and sent everyone, admins included, to the activation screen. Now, when PromptOwl confirms a lapse (3 consecutive rejections, a confirmed suspension, or the end of the 14-day expiry grace), writes stop but reads keep working, nobody is signed out, and the key stays installed, so a renewal or reactivation on PromptOwl's side restores the server on the next check. The activation screen is only for a server that has never been licensed (`/license/status` → `setup_required`).

  **Who hears what.** Server admins, and the key's owner even after it lapsed, get specifics: trial days left, when an expired license's grace period ends, seats in use, a key PromptOwl is refusing, each with a "Talk to PromptOwl" button and email. Everyone else never sees licensing vocabulary, and sees anything at all only once the workspace is actually read-only: "This workspace is read-only right now. Your administrator has been notified." The same split applies to the 503 bodies from the license gate, the server `/mcp` write tools and run writes.

  - New **Settings → License** tab: plan, seats used/licensed, end date and grace, last check with PromptOwl, install a replacement key, and how to reach PromptOwl.
  - New **admin license banner**, never red. Admins can hide it for a week, except within 3 days of anything changing.
  - New `GET /admin/license` (server admin or key owner) with the full detail. `GET /license/status` stays public and carries none of it.
  - `POST /license/install` is public only until the server has a license owner. After that, replacing the key takes the owner or a server admin, so a lapsed license can't be claimed by pasting another key.

- e4ade05: **Metacognition agents: agents the nest runs itself, that only ever propose.** With `FEATURE_METACOGNITION=true` or the Settings → Features switch (and the workflow plane on), an owner or admin can turn an agent document into a metacognition agent from Workflows → Agents. It runs on the nest's model key under its own persona name, on a schedule or on demand: it reads the folders you give it, checks the feeds and MCP tools you allow, looks back at how its earlier proposals were judged, and files fixes and new documents as drafts for a reviewer. It never publishes. Every step, the tokens it used, an estimated cost and who pays (PromptOwl credits, or your own key) are on the run's trace, including runs a person cancels. Off by default.
- 589fc10: **Several boards per nest, saved on the server, with drag-to-rank.**

  - Boards appear as tabs above the board, the way Linear views and ClickUp's view bar work. **+ New board** starts a project board (Tasks only, columns todo / doing / done). Double-click a tab, or open its menu, to rename, duplicate, make private / share with the nest, or delete.
  - Boards are shared with everyone who can see the nest. A **private** board is visible only to the person who made it. Readers see shared boards; writers create and edit them. Only the creator can make a board private, and the creator or a nest admin can delete it.
  - **Stack rank**: drag a card up or down within a column to order it, on every grouping including status. The order is saved per board and per column, so reordering never creates a document version, and two boards can order the same tasks differently.
  - **Tag filter** per board. New cards added on a filtered board get the filter tags, so they don't disappear.
  - The first time a writer opens the Board, the layout their browser had saved becomes the nest's first board, named "Board".

- c5cb674: **Own model keys (Enterprise, byok) for Anthropic, OpenAI, Google Gemini, xAI Grok and Groq, kept in PromptOwl's model gateway.**

  - **Settings → Hootie → Model keys.** With byok, a server admin adds their own key per provider. Each key is checked with the provider on Save and kept by PromptOwl's model gateway (LiteLLM), never on this server; Settings shows only its last 4 characters (`own_providers` on `GET /admin/settings`, set via `provider_keys` on `PATCH /admin/settings`). With no own key, the card says Hootie and runs use PromptOwl's virtual key on your plan's credits. The License tab shows whether own model keys are on (`byok` on `GET /admin/license`).
  - **The Hootie model's provider picks the key.** Any model from a provider with an own key (for example any OpenAI model, `gpt-4o` included) runs on that key; other models use PromptOwl credits. The Hootie model picker is searchable and grouped by provider (`providers` on `GET /admin/models`); a provider with an own key is marked "· your key".
  - **The server-wide Anthropic key and "Model gateway URL" settings are gone.** A key already stored on the server is handed over to the gateway as the Anthropic key on the first boot with byok, then cleared. `anthropic_api_key`, `anthropic_api_key_masked` and `anthropic_base_url` are no longer accepted or returned by `/admin/settings`. A nest's own key in its Tool environment still works for agent runs; without one, agent runs use PromptOwl credits.
  - PromptOwl's licence answer carries the licence's own-provider key and model list when byok is on. The server keeps it encrypted in the licence cache (migration 053) and drops it once PromptOwl stops sending it.
  - **Hootie logs one request and one response line per question** (model, which key by its last 4 characters, token usage, timing). `HOOTIE_DEBUG_LOG=true` also logs the full prompt and answer (nest content) and warns at startup; keep it off in production.

- f6bbf41: **Project boards: tasks, assignees, due dates, priorities, sub-items, and adding cards from the Board.**

  - New `task` node type, which **skips review** so board work can move freely. Prime still wins, and turning a governed document into a task still goes through review. Available once the engine includes `task` (`/health` → `type_task_enabled`).
  - Any node can carry board fields: `assignee` (someone on the nest's roster), `due`, `priority` (urgent/high/medium/low) and `parent` (sub-items). The server records `assigned_at` and `moved_at`.
  - Board cards show priority, due date (red when overdue), sub-item count, last-updated time and the assignee, and you can set each one in place. **+ Add task** sits at the bottom of every column, and the board can be filtered by person ("Only my tasks", "Unassigned") or to tasks only.
  - Dragging a governed document asks first ("this lands as a draft that needs review") instead of quietly creating a draft.

- 58eb0f9: **A refused edit now offers to request access instead of stopping there.** When someone who can read a document or nest tries to change it, they're asked "Request edit access?" with room for a note, and anything they haven't saved stays where it is. The nest owner and admins get the request in My Work (plus email and nest channels) and approve or deny it in one click; approving gives the access through the normal sharing paths (a write share on the document or folder, or nest write), and the requester is told either way. Asking twice shows "Request pending" rather than a second request, and a denied request shows who said no and why, with the option to ask again. Viewers also get a **Request edit access** button on documents and on the nest page. Nests you can't see still answer "not found", with no offer.

  Agents get the same flow over MCP: a refused `context_create` / `context_update` / `context_delete` / `context_move` names `context_request_access` and carries `can_request_access`, the target and the level in its structured result; `context_access_requests` and `context_resolve_access_request` let an owner or admin decide. Over REST the 403 body carries `can_request_access`, `target` and `level`, and `POST /nests/:id/access-requests` files the ask (see API.md).

  Also fixed: a nest viewer who had been given a write share on a document still couldn't edit it — the share was ignored for anyone with nest read access. It now counts on that document's write routes, over REST and MCP.

### Patch Changes

- f0f8d17: **Switching views keeps your place, and comment highlights show in every view.** On a hosted artifact, flipping between Preview and Annotate used to reload the preview at the top and open the text at the top; both now land on the passage you were reading, the preview no longer reloads, and the commented passages are highlighted in both (click one to open its thread; click a thread's quote to go to it). On a document, switching between the editor, Comment mode and the markdown source keeps the same passage on screen, and comments are now highlighted in the editor and in the markdown source too, not only in Comment mode.
- 3bfa3b2: **Approving a document no longer reads it back from storage after publishing.** To record the published version in its database, approval read the document file again right after the publish had written it — a round trip on Cloud Storage. The server's document cache already holds exactly what the publish wrote, so approval now takes it from there, and only reads the file if the cache has no copy.
- f68f900: **An approval that cannot be published is no longer recorded as approved.** Approving a single document recorded the approval first and published afterwards, so when publishing failed the reviewer still saw a successful approval and the document was pinned as approved without being published — the failure only reached the server log. Approval now publishes first: if the document cannot be published, the reviewer gets an error explaining why and the review stays pending. Successful approvals are unchanged, and single and bulk approval now behave the same way.
- 773fbea: **Approve, reject and withdraw make one fewer database query.** Each already loads the pending review before checking the caller's rights, and the rights check then looked up the same review again to find who submitted it. It now reuses the submitter it was handed.
- 1861a2f: **The review queue and activity feed check approval rights in a handful of queries instead of several per document.** Showing whether you can review each pending document ran the full approval check — your nest roles, the self-approve setting, the document's stewards and who submitted it — once per document, one after another. The nest-wide part was identical for every row. It is now resolved once, and the per-document stewards and submitters are fetched for the whole page in one query each, so a 50-document queue makes about eight database queries instead of hundreds. The same check now also filters the queue by steward. The approval rules are unchanged: single and batched checks share one decision function, and a test compares them across every steward scope, ownership and self-approve case.
- 9af4e71: **Bulk approval publishes the whole batch at once.** Approving several documents from the Review tab or My Work used to run a full publish for each one in turn — each sealing its own checkpoint and rebuilding the nest's index. The batch is now checked in a few queries, published in a single engine call (documents in parallel, one checkpoint, one index rebuild), and then recorded and notified per document exactly as a single approval is. A document that is not pending, not yours to approve, or that the engine refuses to publish is reported as failed and left pending, so it can be retried; previously a document whose publish failed could still be marked approved. The version-history note is the reviewer's note, or "Approved in bulk review" when none is given.
- 278820a: Resolved comments now get out of the way. The comments rail lists open threads, with resolved ones folded under an expandable "Resolved (n)" section, and the header counts open threads only. Resolved threads no longer paint a highlight in the document, and the artifact viewer folds its resolved threads the same way. A new "Reply & resolve" button posts a reply and closes the thread in one step. Replying to a resolved thread reopens it, from the web UI or through MCP. The Review tab no longer lists comments from resolved threads. People already in a thread are notified when someone replies. When a thread's quoted text is no longer in the document, the thread shows a "text changed" label instead of pointing nowhere.
- 4cc320b: Bump `@promptowl/contextnest-engine` to ^2.10.0. The engine catalog now declares `count` on `context_search`, so the MCP search response conforms to it without an exception.
- 825ef3c: **Faster publishing and approval from engine 2.10.** Updates `@promptowl/contextnest-engine` to 2.10, which cuts repeated storage reads from every publish and approval: each document's version history is read once instead of several times, the vault is listed once per publish, past versions are rebuilt with their files read together, only the changed folder's index is rewritten, and directories are no longer re-created before every write. On Cloud Storage this removes many round trips from each approval. Search over MCP also now reports the total number of matches.
- 981587e: Bump `@promptowl/contextnest-engine` to ^2.11.0. The engine now knows the `task` node type, so project-board tasks turn on: "+ Add task" creates tasks that skip review, "Task" appears in the editor's type picker, and `/health` reports `type_task_enabled: true`.
- 642e572: **Approving or rejecting a document returns sooner.** Verdict notifications now run after the document's write lock is released, so an author saving the document no longer waits behind them, and the document title is looked up once per verdict instead of three times. In the nest view the reviewed document leaves the review queue as soon as the verdict lands, without waiting for the queue to reload.
- d854ec3: **Folder import records its documents in a few queries instead of a few per document.** Finalizing an import used to write each document's version row, approval and tag index one document at a time, which on a hosted database is a round trip per statement. These are now multi-row writes for the whole batch. The on-disk status repair now runs only for documents whose publish actually failed, rather than reading every held draft back from storage; a held document that states its own status (such as `pending_review`) keeps it on disk instead of being flattened to `draft`. Each staged upload chunk now logs its duration (`[import] staged: … ms=`) next to the existing register timings, so a slow import shows which phase the time went to.
- bde46d9: **License notice no longer sits flush against the header.** In the sidebar layout the admin license banner now has the same gap and side margins as the page content below it.
- 861f702: **Own model keys are a licence feature.** Whether the server may run on its own provider keys or LiteLLM gateway is now the `byok` licence feature — included with Enterprise, and grantable or revocable per licence by PromptOwl — instead of a field in the plan limits. With an older PromptOwl that sends no feature list, an Enterprise licence still gets it by default.
- 2a9d1b9: **Hootie asks the PromptOwl gateway for a model it actually serves.** On the PromptOwl model gateway, models have PromptOwl's team names (e.g. `default-claude/claude-sonnet-5`), so asking for `claude-sonnet-5` failed with "no healthy deployments". Models are now picked and stored by plain name (`claude-sonnet-5`); on the PromptOwl gateway the server adds PromptOwl's instance prefix when it calls, so a name set through the API without it still works. With no model picked, Hootie uses the gateway's default; on your own key, `claude-sonnet-5`. Settings → Hootie → Model is a dropdown of every model this server's key can reach (new `GET /admin/models`, server admins only); if the list can't be loaded, a name can be typed. A model the gateway doesn't serve now reads "No model named … is available on this key" instead of a generic error.
- 86ef697: **Settings → License explains how seats are counted.** The Users and Editors rows each have an (i) with a tooltip: the current count against the plan, that each person counts once at their highest role on any nest, which roles make someone a user (license admin, superadmins, nest owners, admins, reviewers) or an editor, and that invited people with no role and viewers are free.
- f260845: **A suspension takes effect on the next license check, and a restart can't hide it.** A suspended license used to be confirmed only by a check at least an hour after the first suspended answer, and that hour was tracked in memory — so any restart (a redeploy, a Cloud Run instance, `tsx watch` in dev) started it over and the server never went read-only. Now two suspended answers within an hour confirm it (spec §9.4), which with the 60-second check is about a minute; one stray answer still can't. The server also checks with PromptOwl when it starts instead of trusting the 24-hour cache, falling back to the cache only when PromptOwl can't be reached.

  **Nest-level writes are refused on a read-only server too.** Creating, renaming and deleting a nest (and syncing or deleting an unsynced folder) skipped the read-only check, so they still worked while the server was suspended or unlicensed. They now get the same 503 as every other write — the reason for admins, the neutral line for everyone else.

- f0af1a5: Fix Overview and Review Queue not switching the main content when picked from the sidebar, breadcrumb, or browser back/forward.
- 5868288: **Nests page: filters always shown, folders only under their filter, and a better first view.** The filter, scope and sort controls (and the archived list's filter) now show however many nests there are. Unsynced folders no longer appear in the nest list; they show only under "Unsynced folders only". When "My nests" is empty but other nests are reachable (shared, organization, public), the list opens on "All nests" once per visit so they're visible.
- d6739c2: **Saving, publishing and approving no longer read each document back from storage.** After every document write, the server read the file back to refresh its document cache and search index — one extra round trip per save on Cloud Storage. It now uses the text it just wrote, which is exactly what the read would have returned, and a successful delete is recorded without a read. A write that fails part-way is still checked against storage as before.
- 6f1ce7d: **Plan-limit messages are worded for who is asking.** When a role change is refused because the plan is full (`402 plan_limit`), the message now says what is full ("This server's plan includes 5 users (nest owners, admins and reviewers), and all are in use.") and then, for a server admin, "Upgrade the plan from Settings → License to add more." — or, for everyone else, who can't change the plan, "Ask your server admin to add seats."

  **Access keys never take a seat.** Seat counting now skips access-key service identities, whatever role they hold on a nest.

- 0ab3949: **Revoking an API-only access key now confirms it.** After you revoke a key under Collaborators → API-only access, a message says the key was revoked and that anything using it has stopped working. Before, the key just disappeared from the list with no confirmation.
- 38b570b: **Saving a new document as a draft no longer drops you on an empty New document page.** After Save draft succeeded, the app briefly opened the nest and then bounced back to a fresh, empty New document form, which made it look like the content was lost. It now stays on the nest Overview, where the new draft is listed.
- 4a3b7e8: Editor says what saving does: "Publish" when the edit goes live, "Save draft" when it needs review (prime documents, governed nests). Submit for review now saves unsaved edits first ("Saved and submitted for review."), and edits to your own pending submission auto-save to it. Submit and Discard appear right after a save turns a published document into a draft, without a reload.
- 7deb105: Startup banner shows the real package version instead of a hard-coded "v0.1.0".
- ac9a354: **Submitting a document for review reads its version history once.** Submitting seals the draft into the document's history. It already read that history to check whether the version was sealed, and the seal then read it again; it now reuses the first read.
- 6f9a6dc: Held pushes from a shared PromptOwl agent now name the person who drove the chat ("hiren@... via owner@...'s agent") instead of only the agent owner. Reads an optional act claim on the PromptOwl MCP ticket; access is unchanged and stays the owner's.

## 1.28.0

### Minor Changes

- b303dd3: Agent activity with undo. The Review tab has a new Agent activity view listing every change an agent made to the nest: creates, edits, restores and deletions. Each row shows which agent made the change, under which account, and when. The view can be filtered to one agent or widened to everyone's changes. Each change can be undone in one click. Undo writes the previous version back as a new version, discards an unreviewed draft, or removes a document the agent created. It is refused when the document changed since, when the change is awaiting review, or for deletions, and the reason is shown next to the button. Owners, admins and reviewers only. New endpoints: `GET /nests/:id/agent-activity` and `POST /nests/:id/agent-activity/undo`. Deletions now record which agent made them (migration 046).
- 943056b: Publish a nest API-only (headless). An owner or nest admin can turn on API-only access for a private nest (Collaborators tab, or `PUT /nests/:id/headless`) and create one read-only access key per buyer or integration, each labeled and revocable. A key works with `ctx` and any MCP client to list, get, query and search the nest's approved documents, and nothing else: no browsing, no sign-in, no drafts or version history, no comments, no export, no writes. Everything else answers 403 `headless_reader`. Each key is its own service identity, never shown as a person in people search, the teammates list or user counts. Turning API-only access off pauses every key, and deleting a key revokes it. While a nest is headless it stays private.
- 10df909: Hootie in the nest is now a side panel instead of a chat bubble, off by default, and Enterprise licences can rename and brand it.

  This reverses the 1.27.0 choice of a corner chat window over a full-height slide-over. The assistant opens from a slim tab on the right edge and slides in beside the page. On screens 1280px and wider it pushes the page over rather than covering it; on narrower screens it overlays. Drag its left edge (or use the arrow keys on the handle) to resize it between 340px and 720px; the width is remembered per browser, and a double-click resets it. Closing it keeps the conversation, as before.

  **Behaviour change:** `HOOTIE_ENABLED` now defaults to off. A server that had Hootie on only because it was the default will find it off after upgrading. Turn it on under Settings → General or with `HOOTIE_ENABLED=true`. A server that set `HOOTIE_ENABLED=true` in its deploy environment, or turned it off in Settings, keeps that choice. Both states are now written explicitly from Settings, so a UI choice beats the deploy env either way. The startup banner prints whether Hootie is on.

  **Custom identity (Enterprise):** admins set the assistant's name, logo (an https image link), accent colour (hex) and greeting under Settings → General, or with `HOOTIE_NAME`, `HOOTIE_LOGO_URL`, `HOOTIE_ACCENT_COLOR` and `HOOTIE_GREETING`. The identity shows on the edge tab, the panel header, next to each answer and in the greeting, and the name also goes into the assistant's system prompt and the comments it posts for @mentions. `/health` reports the identity to show as `hootie_brand`, decided on the server. Without an Enterprise licence (tier `enterprise`, valid and not suspended), `/admin/settings` refuses a request that would change any branding field with `403 enterprise_required` and writes nothing from it (sending back the stored values unchanged is allowed), and every surface shows the default Hootie. A licence that lapses reverts to Hootie on the next request without deleting the stored values.

- fdeb253: Push Confirmation Gate — hold agent writes for review on a gated nest.

  A superadmin can require confirmation for agent writes to a nest (`require_push_confirmation`, superadmin-only to set via `PATCH /nests/:id/settings` — a per-field `403` for anyone else). On a gated nest, a document created by an agent or script is **held** as a pending record (`202 pending_confirmation` with a `poll_url`/`confirm_url`) instead of applying; it lands only after a reviewer confirms it in the web UI, through the exact same apply path an immediate write uses — same engine create, same version rows, same skip-don't-overwrite semantics, attributed to the submitter. With the gate off, behaviour is unchanged.

  The gate covers the three ways an agent CREATES a document: the MCP `context_create` tool (always, whatever credential it arrived on — it answers a `PENDING_CONFIRMATION` tool error, since nothing was created), `POST /nests/:id/nodes` on an API key, and the bulk `POST /nests/:id/publish`. A person working in the web UI (session cookie) is never held, and edits to existing documents keep going through stewardship review, which is built for them.

  - New `pending_pushes` table (carries the full staged payload so a confirm applies it byte-for-byte) and a **per-API-key** `push_allowlist` (`key_id` `''`/null = all of that user's keys; never keyed on nest alone). Idempotent SQLite + Postgres migrations (`040_push_confirmation`).
  - New endpoints under `/nests/:id`: `GET pending-pushes`, `GET pending-pushes/:pid` (readable by the **submitter or a reviewer** — the CLI polls with the pushing key), `POST …/:pid/confirm { always_allow? }`, `POST …/:pid/reject`, `GET/DELETE push-allowlist`. **Confirming is reviewer/owner/admin only — never the submitter**, or the gate would be one extra call away from being cleared by the key it is holding; a submitter may reject (withdraw) its own write. Confirm/reject on a no-longer-pending record → `409`, and a confirm whose apply throws returns the record to `pending` instead of stranding it as applied-with-nothing-written. Doc/folder grantees are denied `/publish`.
  - The allowlist is governance-licensed (`503` without a license); the `/pending-pushes` routes deliberately are **not** — the write endpoints are unlicensed, so licensing the release path would let a lapsed license hold every write with nothing able to confirm it, and the nest would stop accepting writes with no in-product way back.
  - Held payloads are bounded by `MAX_PENDING_PUSH_BYTES` (default 5 MB) and expire after `PENDING_PUSH_TTL_MS` (default 7 days), reported lazily as `expired`.
  - Web UI: a loud confirm modal (which nest — name + id verbatim, how many documents + a title·type·tags manifest with new-vs-update badges, who wrote them, and an "Always allow automated writes" checkbox that whitelists that exact key), a held-write banner + count badge in the nest view, and — in nest settings — the superadmin-gated `require_push_confirmation` switch plus the list of whitelisted keys with a Revoke action, so "Always allow" is not a one-way door. Reviewers are notified when a write is held.
  - The nest feed API also emits a `pending_push` item carrying the manifest and a per-caller `canConfirm`, for clients that want held writes inline with the rest of the activity. The nest view surfaces them through the banner instead, so nothing renders that item yet.
  - A held write's manifest entry carries the id the title will publish to, or `null` when the title has no ASCII slug and the id can only be generated at apply time. It is a preview for the new-vs-update badge, not a promise: an id that is occupied by the time a reviewer confirms is skipped, never overwritten.

  Shares one wire contract with the paired `ctx push` change in `PromptOwl/ContextNest` (the CLI polls the gate and prints the confirm URL) — the CLI pushes through `POST /nests/:id/publish`, one of the gated surfaces.

- Sign in with Google through PromptOwl. When this server accepts PromptOwl SSO tickets, the login page shows a Sign in with Google button that signs in through PromptOwl's community SSO (a first-time Google user gets a PromptOwl account there and a ContextNest account here). `GET /health` reports the URL as `promptowl_google_url`. The button follows the same gate as Sign in with PromptOwl, and an OIDC provider whose issuer is Google no longer shows a second Google button.

  Sharing a document or folder with someone outside the nest now emails them, naming the document or folder, the nest, the permission and who shared it, with a link to open it. Role changes on an existing share and shares to nest members send nothing. A failed email is logged and never fails the share.

  A document opened from the review queue now returns to the queue on Back, approve or reject, so a reviewer goes straight to the next item. Document histories are cached per document and invalidated when the document changes, including writes from another server instance, so reopening a document's history no longer rebuilds it each time.

  Engine dependency bumped to `@promptowl/contextnest-engine` ^2.9.1.

- b6d91b0: Activity log for a document, a folder, or the nest, for admins. Owners and nest admins get an Activity entry in a document's ⋯ menu (document page and card view), on a folder's row, and in the nest's ⋯ menu. It opens a log of who created, edited, restored, reviewed, commented on, deleted, read, pulled into a search or answer, or exported that document or anything under the folder, newest first, with the agent and whether it came through the web/API or MCP. The log can be filtered to changes, reviews, comments, or reads & pulls, and to one person. Reads, retrievals and exports are now recorded per document (migration 047) — how a document was pulled, never what was searched for or asked, throttled to one row per person, document and action per 10 minutes and pruned on the activity-trace retention window. New endpoint: `GET /nests/:id/activity-log`.
- 1b10bf2: Server settings are regrouped into tabs: **Basic** (community name, public base URL, logo, sign-in methods, product analytics, upload size, trace retention), **Features** (every on/off switch — workflow plane, sub-agents, PromptOwl teams import, content types, usage telemetry, single sign-on, agent SSO, nest creation, people directory) and **Hootie** (the chatbot with its model key). Single sign-on and agent SSO are switched on in Features; their configuration moves to a **Single sign-on** tab that appears only while one of them is on. New `community_name` setting (`COMMUNITY_NAME`), editable under Basic.

### Patch Changes

- ec72345: Copying a new API key in a nest's API-only access panel now confirms with a "Key copied to clipboard" toast, and falls back to the legacy copy path (with an error toast) when the clipboard API is unavailable.
- 6a5c3a4: Revoking an API key in a nest's API-only access panel now asks for confirmation in the app's own dialog instead of the browser's native confirm popup.
- aa26f0e: The API keys page now has list controls: a search box matching a key's name, prefix or nest, a filter for all-nests keys versus one-nest keys, and a sort by newest first, name, or most recently used.
- 172f0b1: An editable document now opens as a clean reading page. The formatting toolbar, the Type control and the Prime box appear once you click or tab into the page, and go away when you click outside it. Menus and dialogs opened from the page keep them visible. New documents still show the controls from the start.
- 99c846e: Fix the "Unsaved changes" dialog appearing right after saving a document.

  Saving navigates back to the nest, and that navigation is checked by the unsaved-edits guard. The save had already cleared the dirty flag, but React had not re-rendered yet, so the guard still saw the document as dirty and opened the leave dialog — asking the user to save the edits it had just written, with the save button reading "Saved" behind it.

  A save is the answer to that question, so every save path now runs its follow-on navigation past the guard. Discard and "Save & leave" already did; the plain Save button was the one path that did not.

- 99c846e: Fix nest activity-feed totals on Postgres.

  `COUNT(*)` comes back from Postgres as a bigint, which `pg` hands to the app as a string, so the feed's totals concatenated instead of adding: a nest with 12 pending changes and 3 held writes reported 123 items. SQLite was unaffected (it returns a number), so this only ever showed on a Postgres-backed server.

  Each count is coerced with `Number()` before the arithmetic. The per-type `counts` object was already correct — only the summed `total` was wrong.

- c02f9a2: Held pushes now show when they expire. The pending list in a nest shows a countdown on each entry (for example "Expires in 6d"), and the review dialog shows the exact expiry time and explains that a push not confirmed by then is dropped.
- 32bd441: Reviewers can now read a held push before confirming it. In the review dialog, clicking a document shows its full content, a staged context.md can be expanded, and a summary counts how many documents are new and how many are updates. `GET /nests/:id/pending-pushes/:pid` now returns each manifest row's `content` and the push's `context_md`. The list endpoint is unchanged.
- 2f836fb: Fix "Always allow" doing nothing for pushes from PromptOwl. PromptOwl writes to a nest over MCP with a signed service ticket rather than an API key, so the held push carried no key to whitelist and every later push was held again. Confirming such a push with "Always allow" now whitelists that user's keyless agent writes (PromptOwl and signed-in MCP) on that nest, shown in the nest settings as "PromptOwl / signed-in session". The user's API keys are not affected and still need their own approval.

## 1.27.0

### Minor Changes

- 5e1f545: Hootie in the nest: a floating assistant on every page of the UI. It answers from what the person asking can read in the nest (the `/context` retrieval, run as the caller), streams the answer, cites the documents it used as chips that open them, follows the document you have open, and lets you `@tag` a colleague — which posts the exchange as a comment on that document and notifies them like any comment mention. `/` switches the nest. New `POST /nests/:id/chat` route (read tier, per-user rate limit), `HOOTIE_ENABLED` toggle in Settings → General (default on), answers with the server-wide Anthropic API key and says so when there isn't one. Model and model gateway URL (LiteLLM / PromptOwl) are superadmin settings too; the gateway URL also flows into agent runs, so one setting routes every model call.

  The Anthropic API key is checked against the provider when an admin saves it, so a key that does not work is refused at the box that sets it rather than surfacing later as a failed answer. When a model call does fail, the panel says what actually went wrong — out of credit, a rejected key, a rate limit, an overloaded model — instead of one generic line. Only the asker's own @mentions notify anyone: a name written by the model, echoed out of a retrieved document, reaches the comment but nobody's inbox. Without an API key the launcher is shown to admins only, who can act on it. The panel opens as a chat window in the corner rather than a full-height slide-over, so the page stays visible behind it.

- cf0a89a: Stored credentials are now encrypted at rest. The secret server settings (Anthropic API key, OIDC client secret, MCP signing secret, SMTP URL, Slack and Teams webhook URLs, the SES secret access key, the license key) and every value in a nest's Tool environment are stored AES-256-GCM encrypted instead of in the clear, so a row read in isolation — a log line, an export, one table's replica — is not the credential. Non-secret settings stay readable. The master key is generated on first use and kept in the database, so it survives redeploys and is shared by every instance with nothing to configure; set SECRETS_KEY in the deploy environment to supply your own and keep the key out of the database it protects. Values written before this are read back as plaintext and re-encrypted on their next save — nothing to migrate — and a value that cannot be decrypted is logged by name and treated as unset rather than failing the boot. Known exception: the license validation cache is still keyed by the license key.

### Patch Changes

- df4a8c4: In the Add with AI modal, Connect in the API key note is now a link that opens the nest's Connect dialog, where the key is minted.
- ab94585: Documents whose approved version can no longer be rebuilt (history damaged by an older import) no longer show up empty to readers. On the read that hits one, the approval moves to the newest published version that still rebuilds, credited to the server (system:approved-heal) rather than the original reviewer, and that version's history entry notes the move (Approved version moved from v3 to v4 — v3 could not be rebuilt). No version is created, the saved history is not rewritten, and a draft or pending version is never promoted. This covers the public reader, the document list, exports and MCP reads. If no newer published version rebuilds, nothing changes.
- e6025f5: The Nests dashboard opens on My nests again after you last used All, Organization or Public, so other organizations' nests are never the first screen. Narrow scopes (Owned, Shared, Synced, Unsynced) are still remembered.
- 5c47b52: A nest's description now shows on its Overview even before it has any documents, above the Add the first page actions, the same as on a nest with pages.
- a795fab: Add a Delete folder action in two more places. The nest Overview's folder rows now show a delete icon next to New document and Open in Documents, and the Documents tab's folder filter line shows Delete folder when the filtered folder holds no documents. Both open the same confirmation (or deletion request, for editors) the Documents tree already uses.
- 392861f: Import in a nest opens a centred dialog listing Files, Upload PDF and Whole vault, the same way New Document and Add with AI open, instead of a dropdown anchored to the header button. The Overview's Import files action opens the same dialog.
- 90949c6: Replace PDF now asks for an optional change note before you pick the file, and records it on the new version. Left blank, the version history keeps the default Replaced the PDF.
- a12c13f: Replacing a PDF shows the same centred upload card as an import, naming the file being uploaded, instead of only a spinner on the Replace PDF button.
- ab13414: Every oversized PDF upload now gets the same message, for example PDF too large (30.0 MB, max 25 MB), in the admin-configured MB. A file far over the limit used to hit the server's generic body cap and show a raw Request body too large error with byte counts.
- 5035c43: Uploading files into a nest shows a large, centred progress card naming the file (or file count) being uploaded, instead of a small muted spinner that was easy to miss during a slow PDF upload.
- 29a9eb8: A nest shared with you no longer appears in your Nests grid as viewable or editable while its invite is still pending. It shows only under Pending invites until you accept it.
- 3d99297: When a Server settings save is rejected, the offending field is marked in place with a red border and the server's reason underneath (for example an invalid Public base URL), not only in the banner at the top. The mark clears on the next edit.
- 72ab1b7: The Suggest everyone on this server and This server hosts several organizations toggles in Server settings now describe their behaviour as a short summary followed by separate Off, On and In either state points, instead of one dense paragraph each.

## 1.26.0

### Minor Changes

- 1de7850: Email can now be sent through AWS SES as well as SMTP. Server settings → Notifications → Email has an SMTP / AWS SES choice; SES takes a region and optional access keys (leave them empty to use the server's IAM role). Credentials are verified on save, the SES secret is write-only, and saving one provider clears the other's settings. New settings: `EMAIL_PROVIDER`, `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`. `GET /admin/settings` now also returns `email_provider`, `ses_region`, `ses_access_key_id` and `ses_secret_access_key_set`.
- 1c96bd9: Only server admins can create nests by default. New `NEST_CREATION` setting (`admins` default, or `everyone`) gates `POST /nests`, folder import and the MCP `nest_create` tool with a `403` for anyone else, and `GET /health` reports it as `nest_creation`. Non-admins no longer see New Nest, Import Folder or Create First Nest; with no nests they see "You don't have access to any nests yet. Ask [admin] to share one." Set `NEST_CREATION=everyone`, or turn on Settings → General → Nest creation, to keep the old behaviour.
- 61d583c: Nest-scoped API keys are now isolated to their nest. A key minted with `nest_id` could previously mint itself an unscoped whole-account key (`POST /auth/keys`), rotate itself to user-level, delete other nests, search and list every nest, and — owned by an admin — reach `/admin/*` and teammate management. A new app-wide guard makes a nest key deny-by-default outside its nest: it reaches its own nest, `/mcp` and `/index` (filtered), and `GET /nests` / `/search` / `/stats` narrowed to its nest; everything else answers `403` with `code: "nest_scoped_key"`. Minting or rotating a key onto a nest now requires access to that nest (`404` otherwise), and key responses report `nest_id`. In the app, the API keys page shows each key's scope ("All your nests" / "Nest: <name>") and has a scope picker, and a nest's Connect dialog can mint a key for that nest only, shown with the nest's MCP URL. Sessions and user-level keys are unchanged.
- c8d328e: The Nests page shows a Pending invites card for nests shared with you that you haven't acted on yet. Accept opens the nest; Decline removes your own access to it. New endpoint `POST /me/nests/:nestId/leave` drops the caller's own collaborator row and settles the invite (`left: false` when the access came through a team or ownership).
- e214fe8: Per-nest branding for public reader sites.

  A nest owner or admin can now brand what readers see — the reader-mode docs site and the nest's `/p` published links: a **logo**, a **banner** (image and/or headline + subtext, shown on the home page), an **accent color** (links, the current page, buttons), a **header background color**, an optional **page tint**, a **site title**, **footer text + link**, and an optional **favicon**. Open it from the nest's **Reader** button → **Branding → Customize**; the dialog has a live preview.

  Colors are strict `#rgb` / `#rrggbb` and applied as CSS custom properties. Text on any color is picked automatically (black or white, whichever meets WCAG AA 4.5:1), and the accent used as link text is deepened until it reads at 4.5:1 on the page. Images are uploaded nest assets (PNG/JPG/GIF/WebP — SVG stays excluded) or `https://` image links.

  On `/p` the CSP is unchanged: uploaded images are inlined as `data:` images (already allowed); external https images are not shown there. HTML/artifact publishes are the author's own page and are not wrapped.

  `PATCH /nests/:id/branding` (owner / nest admin / server admin) replaces the branding; `null` or `{}` resets it. Hiding "Powered by ContextNest" / "Secured by PromptOwl" is server-admin only. `GET /nests/:id` returns the parsed `nest.branding` (null when unbranded). Nests with no branding render exactly as before; the server-wide `LOGO_URL` still brands the app shell and is the logo fallback for a branded reader.

### Patch Changes

- ae96a3c: Ask for confirmation before rotating an API key. Rotate on the API keys page and in the Connect dialog now opens a confirmation dialog that names the key and warns that the current key stops working immediately, instead of rotating on the first click. Revoke on the API keys page uses the same in-app confirmation dialog instead of the browser's native confirm popup.
- 770c138: Fix Board's "Columns by: Folder" labeling nested folders with only their leaf segment.

  A folder column's label shortened to its own name unless it collided with another folder of the same leaf name — so `no/such/folder` showed as just `folder`, dropping the hierarchy, and only actual leaf-name collisions ever grew back a distinguishing prefix. Folder column labels now always show the full folder path, matching the tooltip.

- 8fd23cf: Fix Board "Columns by: Folder" labels hiding the actual folder name for deeply nested paths.

  Showing the folder column's full path (see previous fix) solved ambiguous same-leaf-name folders, but for a path many subfolders deep the header's CSS truncation elides from the end — hiding the leaf, the one segment that actually names the folder, behind the ellipsis. Folder column labels now shorten from the front instead: a long path shows `…/parent/folder` rather than `folder-name-that-gets-cu…`, so the leaf stays visible while the tooltip and drag/drop key still carry the untouched full path.

- 5e39dbf: Fix the header breadcrumb overflowing the page for a nest with a very long, space-less name.

  A crumb's label only truncates once it's allowed to shrink below its text's own width — as a flex item it wasn't, so an unbreakable name rendered at full width, pushing the page past the viewport and leaving a horizontal scrollbar with blank space past the (now too-narrow) header divider. Crumb labels now shrink and ellipsize instead.

- 98bfe37: Fix removing a collaborator showing a native browser confirmation popup instead of the app's styled dialog.

  The native `window.confirm()` popup also displayed the deployment's internal Cloud Run URL in its header. Removing a collaborator now opens the same styled `AlertDialog` used elsewhere in the app; the remove action itself was unaffected.

- f893b4e: Show a success toast after removing a collaborator's access, so the admin gets confirmation the removal went through instead of the row just disappearing silently.
- 0553113: Warn about inbound links before deleting a document. Both delete confirmations (the editor menu and the Documents tab) now say how many documents link to this one, e.g. "1 document links to this — deleting it will break that link."
- d7298a9: Show the document creator's display name instead of their email in the document metadata ("Created by"). The email moves to the hover tooltip and is still shown when the person has no display name.
- e4ef5fd: Show a success toast after saving edits to an existing document. The save navigates back to the nest before the editor's "Saved" hint could be seen, so there was no confirmation the changes were stored. A save with no changes keeps its existing "no changes" message.
- 2822fcf: Show the document's "Created by" and "Collaborators" metadata on separate lines instead of one wrapping row joined by a dot.
- 691db10: Fix saving an existing document navigating to the Nest Overview page while the address bar kept the document's `?doc=<id>` URL.

  Clicking **Save** on an existing document reused the same "go back to the nest" continuation as creating a brand-new one, so every save moved the app view to Overview without touching the URL — leaving the breadcrumb and page out of sync with `?doc=<id>` until a reload reopened the editor. Saving an existing document now leaves the editor open on that document; only creating a new document still returns to the nest.

- 2934ae3: Fix dragging an unsupported file (SVG, PDF, .txt, ...) into the document editor: the "Drop to add an image or video" overlay is now skipped when the browser's drag-over MIME type identifies the file as unsupported, and dropping one now shows a toast naming the file and the accepted types instead of silently doing nothing.

  The drop overlay only checked whether the drag carried files at all, not whether any of them were an accepted image/video type, and `handleDrop` returned early for a rejected file without any feedback — worse, without calling `preventDefault()`, letting the browser fall back to navigating the tab to the dropped file.

- cef9513: Make deleting a folder clear, including empty ones. An empty folder now shows its delete action without a hover, the confirmation and toast no longer talk about deleting "0 documents", and an editor's deletion request on an empty folder is accepted instead of failing with "Folder not found".
- 8d305f0: The Teammate added window now says when the temporary password was already emailed, instead of always asking the admin to pass it on by hand. When PromptOwl sign-in is open to everyone, both that window and the invite email mention Sign in with PromptOwl using a PromptOwl account under the same email. `POST /auth/invite` returns two new fields, `emailed` and `promptowl_sign_in`. The same window warns "This person has no nests yet. Share one?" with a nest picker, so a new teammate doesn't land on an empty server.
- f472c4f: Invited users get a guided sign-in. Invite emails, and share emails to someone who hasn't signed in yet, link to the login page with `?invite=<email>`: the email is prefilled, a banner explains how to get in, the PromptOwl button reads "Continue with PromptOwl" and passes the invited email on to PromptOwl. Signing in with a PromptOwl account under a different email warns that nests shared with the invited address won't show. A failed password login explains the invite options instead of a bare "Invalid credentials", and the self-registration errors no longer point at a "Set your password" option that doesn't exist.
- 245ca28: Anyone added on someone else's behalf now gets a way to sign in. Sharing a nest, a document or a folder with a new email, adding them to a team, or assigning them as a steward (in the app or over MCP) creates their account with a real temporary password and emails it to them with a sign-in link — the same email a Teammates invite sends. Previously only the Teammates invite did this; the other paths created an account nobody could sign in to until an admin reset its password.
- 7be9b34: A single answer from PromptOwl's licensing service can no longer unlicense a working server.

  **Suspension now goes through the two-strike window it was designed for.** PromptOwl answers a suspended key with `valid: false` plus `suspended: true`. The server returned that `valid: false` as-is, so the license went invalid on the first strike. The 60s safety poll then saw valid → invalid and ran the full revocation, which logged every user out and deleted the stored key. The 1-hour confirmation window never got to run. A suspension flag now keeps the cached license: nothing changes during the window, and once the suspension is confirmed writes return 503 while reads keep working. A suspension never wipes sessions or deletes the key.

  **An explicit rejection is acted on only after three in a row.** Previously the first `valid: false` cleared the cache and dropped the server to unlicensed with no grace: every non-GET returned 503, including MCP. That was stricter than the treatment of an unreachable licensing service. Now a previously valid key keeps serving until PromptOwl rejects it three consecutive times (about 3 minutes at the 60s poll), and any valid answer resets the count. Installing a key (`POST /license/install`) still fails immediately when PromptOwl rejects it. CU-wdqcq01kh5.

- 274bea0: Fix inline text in angle brackets (e.g. `Array<string>`) being silently dropped when switching to the Rich editor, and in the read-only Preview.

  CommonMark treats any `<word>` as a raw HTML tag, not just real markup. Once parsed that way, an unrecognized tag name like `string` has no separate text of its own to fall back to, so the Rich editor's ProseMirror parser dropped it entirely and the read-only Preview's HTML-stripping erased it outright — in both cases permanently, since saving and reopening re-parsed the already corrupted text. Both pipelines now only treat a small allow-list of real HTML tags (the ones this app actually round-trips, like the color-mark `<span>`) as markup; anything else renders as the literal text it is.

- 04957b4: Fix the My Work sidebar badge overcounting relative to what the My Work page actually shows.

  `GET /me/work`'s `pagination.total` was the raw `getReviewQueue` count: every pending review in every nest the caller can _see_, regardless of who requested it or whether the caller can approve it. But `items`/`waiting` only ever surface a review that is the caller's own request or one they can actually approve — a viewer/editor's nest with someone else's pending review inflated `total` without that review ever appearing in either bucket. The approve-capability check was also only resolved for nests appearing in the current page of results instead of every nest the caller can see, so the undercount/overcount shifted depending on pagination. `pagination.total`'s review portion is now computed the same way `items`/`waiting` are: pending reviews in nests the caller can approve, plus the caller's own pending reviews elsewhere.

- ecaeb3f: Fix the My Work sidebar badge undercounting when a pending deletion or archive request is waiting.

  `GET /me/work`'s `pagination.total` came straight from the review queue's count, which only tallies pending reviews. Deletion and archive requests ride the same `items`/`waiting` buckets the My Work page renders, but were never folded into `total` — so a pending deletion/archive flag made the sidebar badge undercount by one per flag, and a hard refresh didn't fix it since the server was returning the wrong number, not a stale one. `total` now includes the deletion/archive rows actually shown.

- b254981: Separate archive and deletion requests from reviews in My Work. Reviews now list first under the "Select all N reviews" bar; requests follow under their own "N requests · approve or reject each one" header, since they are decided one at a time and never join the bulk action.
- 961cb06: Fix the nest header flashing the wrong Visibility and Reader Mode state on load.

  Opening a nest previously showed the **Private**/**Reader: Off** defaults for a moment before the real values arrived from the initial fetch, so a public nest with Reader Mode on would briefly look private with reader mode off. The visibility toggle/badge and the Reader Mode button in the nest header now stay hidden until the nest's first fetch resolves, instead of rendering their placeholder default state.

- 284f300: The nest Overview now reads like the public docs reader: the folder index on the reader's card surface with nav-style rows, the nest's description as its lede, the document / folder / governance counts as one summary line instead of a grid of stat cards, and Recently edited in a side card. An empty nest gets a proper start page (New document, Import files, Add with AI). At phone width the nest name no longer truncates to a letter, the Overview's actions fit on screen, and the app header no longer scrolls sideways.
- 0f57363: Hide "Move to folder" for PDF documents instead of offering an action the server always rejects.

  A pdf node's binary is bound to its id, so `src/nodes/service.ts`'s `moveNode` refuses every PDF move with "PDF documents can't be moved to another folder yet." The UI didn't know that: both the document editor's overflow menu and the documents-list row menu/drag-and-drop still offered Move on a PDF, walking the user through a dialog that could never succeed. Move is now withheld for PDF documents in both places (shared logic in `nodeTypeSupportsMove`); every other action is unaffected.

- 085d858: Fix the "Add a person" field's suggestion dropdown reopening with an empty query (listing every server account) after adding a collaborator by pressing Enter. The list now closes as soon as Enter submits the typed address, instead of staying open and re-querying once the field cleared.
- 4fed5f4: Fix the person picker opening its full suggestion list as soon as a dialog opens. The Assign Steward dialog focuses its email field on open, and the list opened on any focus, covering the Scope and Role fields. It now opens on click, typing or ArrowDown. Applies to the collaborator and team pickers too.
- 6235950: Fix folder names casing inconsistently between the authoring sidebar and Reader navigation.

  The authoring sidebar's `prettyFolder` title-cased every hyphen/underscore word (`fold-er-tab` → `Fold Er Tab`), while Reader's `humanize` only capitalized the first character of the whole slug (`Fold er tab`). Reader's `humanize` — used for its folder section labels and breadcrumbs — now title-cases each word the same way, so the same folder reads identically in both surfaces.

- 83b44b0: Re-inviting an existing email from Teammates no longer issues a new temporary password. `POST /auth/invite` now returns `409` for any existing user and leaves their credentials alone: "already a member" once they've signed in, or "already invited but hasn't signed in yet — use Reset password" otherwise. Previously a not-yet-signed-in user's first password was silently replaced.
- 93655c9: Fix a rejected Server settings save (e.g. an invalid PostHog project key) showing the same error twice, as a toast and in the inline banner. The error now shows once, in the inline banner, which also switches to the tab holding the rejected field.
- 1bacb00: Single sign-on is now fully documented. CONFIGURATION.md → Single sign-on (OIDC) is a complete admin guide: prerequisites, a settings reference (env var ↔ UI field ↔ default), step-by-step setup for Microsoft Entra ID, Google, Okta, Keycloak and any other OIDC provider, what happens to existing password accounts, invites, API keys, MCP clients and Agent SSO, offboarding, shared-deployment limits, and a troubleshooting table giving the cause and fix for every `sso_error` code. UI locations now match the Admin rail (Admin → Server settings → Single sign-on, Admin → Teammates). The in-app How it works page has a Single sign-on section for server admins.
- 1bbc356: Fix the "Teammate added" confirmation modal overflowing horizontally — the temporary password field and the "Pick a nest…" dropdown extended past the modal's edge and were clipped.

  The modal's content area is a CSS grid; the temporary-password `<code>` element was a flex item without `min-w-0`, so it kept its full unbroken-text width when computing the grid column's minimum size. That blew the shared column out past the dialog's max width, dragging every other field in the modal — including the nest picker — along with it. The `<code>` element now allows shrinking, so `break-all` can wrap it within the dialog like intended.

- 4b80dbe: Fix the Teammates page "Last active" ignoring web-app activity. It only read API-key usage, so someone working in the web app never moved it. It now takes the latest of API-key use and web-session activity.
- b29bd3c: Fix reloading (or directly opening) `/teams` showing the raw Teams API JSON instead of the Teams page.

  The client's Teams page URL is `/teams`, which collides with the top-level `GET /teams` API route — in-app navigation never re-requests it, but a hard reload or a bookmarked link issues a real `GET /teams`, which the API route answered first with `{"teams": [...]}` instead of the app shell. A guard ahead of the `/teams` route now serves the SPA shell for a real browser navigation (same document-navigation check the SPA catch-all already uses) and leaves the app's own API fetches untouched.

- 5e0cf09: `contextnest://` links are graph edges, and a selector's `hops` actually expands

  `POST /nests/:id/context` hop expansion and the ontology graph (`GET /nests/:id/graph`) only followed `[[wikilinks]]`. A node linked with the spec's own link form, `[text](contextnest://nodes/…)`, was never returned at any `hops`, and never drawn as an edge, while a `[[wikilink]]` at the same distance was. Both now follow `contextnest://` links, including pinned and anchored forms (`contextnest://nodes/foo@3#bar` links to `nodes/foo`). The target is matched by id only, so a dangling link draws nothing and can't attach to an unrelated node that happens to share its slug. Links quoted in inline code or fenced code blocks are ignored.

  An explicit engine `selector` now honours `hops` as documented. Before, the engine ran in full mode, which ignores `hops`, so only `[[Title]]` selector parts were ever expanded. `hops: 0` results are unchanged. A selector request that omits `hops` gets the documented default of 2, so linked neighbours now come back where they previously did not.

- 1d79e1e: Fix a YouTube/Vimeo (or uploaded video) URL placed right after an image losing its embedded player after save + reload.

  The editor's image node is configured as a top-level block so `![alt](url)` round-trips through markdown, but its serializer never closed its block — so the paragraph written immediately after an image (a bare video URL) had no blank line separating it from the image line. On reparse, CommonMark's lazy-continuation rule folded the two into one paragraph, so the video URL was no longer alone in its paragraph and Preview rendered it as a plain link instead of an embedded player. The image serializer now closes its block like every other block-level node does.

- 5f10d90: Fix pressing Backspace at the start of the paragraph right after an embedded video merging that paragraph into the video's URL, corrupting the link and destroying the player.

  The video player is a decoration over a plain paragraph whose text is the bare URL, so a Backspace at the start of the following paragraph hit ProseMirror's default `joinBackward` and appended the typed text straight onto the URL. The editor now redirects the first Backspace into the video paragraph instead of merging into it, leaving the video and its URL intact.

- 6c78c5b: Fix Backspace below an embedded video still corrupting its URL. The earlier fix moved the caret into the video's hidden URL text, so the next keystroke edited the URL and removed the player. Backspace at the start of the line below a video now selects the whole video (outlined), like an image; a second Backspace deletes it cleanly. An empty line below the video is removed first.
- 934caaa: Fix unresolved `[[…]]` links losing their broken-link styling in read-only views.

  The editor already styles an unresolved `[[Title]]` link differently (purple, dotted underline) from a resolved one (blue, solid), but the read-only renderer used by the "Preview" toggle, Comment mode, and the nest View mode rendered every link as resolved regardless of whether it actually pointed at a document. Both now resolve the target the same way the hover preview does and fall back to the broken-link style when it doesn't.

- 98a4b50: Fix the New Document form prefilling with the internal node id (`nodes/<id>`) instead of the wiki-link's human-readable title when clicking a broken `[[Title]]` link.

  Aliased wiki-links store `[[nodes/<id>|Title]]` — the internal node id as the target, the readable title as the display alias. Once the target document was deleted, the click handlers fell back to that raw target for the create/blocked title instead of the alias, leaking the internal id into the New Document form (and into the reviewer's "doesn't exist" message). Broken links now prefill with the link's display text.

## 1.25.0

### Minor Changes

- 34a6b6d: Server settings has a **Connecting agents** tab: verified setup steps for nine AI tools, all pointing at the one endpoint that reads across every nest a person can see.

  An operator who stands a nest server up gets asked "how do I wire this into <tool>?" by everyone on their team, and every tool spells it differently — a flag on `claude mcp add`, a TOML table for Codex, a YAML block for Hermes, a web form for ChatGPT, Grok and Claude. Nothing in the product answered that, so the answer lived in whatever someone could reconstruct.

  The new tab covers Claude (claude.ai and Desktop), ChatGPT, Grok, Perplexity, Claude Code, OpenAI Codex CLI, Hermes, Gemini CLI and Cursor, grouped by chat / command line / editors, with per-harness and copy-all buttons. Every one of them points at the server-level `/mcp` endpoint rather than a per-nest URL, so a person connects once and reads across the public nests plus whatever private nests they have access to — and nothing has to be redone when they are added to another nest.

  Two things the panel now says that nothing said before: a **user-level** key is required, because a key scoped to one nest narrows that same endpoint back down to that nest (`nestScope`, `src/auth/middleware.ts`) and looks exactly like the connect-once promise being broken; and each person should use their own key, because a shared key makes all of them the same user to this server. In open mode no credential is mentioned at all. Where a surface only drives an OAuth client and this server has no authorization server to offer it — Perplexity today — the panel says so plainly instead of printing steps that end in a failed connection.

  The text is a pure, unit-tested module (`ui/src/lib/agent-connect-docs.ts`), so the invariants are enforced rather than maintained by hand: no harness may render key material, none may render a per-nest URL, and open mode must drop every credential instruction.

  `PUBLIC_BASE_URL` is now validated when it is saved. It has to be a plain `http(s)` URL, with no whitespace, quotes or shell characters (`" ' \` \ $ ; | & < > ( ) { }`). Those were previously accepted — the setting was stored after nothing more than a trim — and this value is rendered straight into the snippets above, including a `bash`block and quoted strings in`config.toml`, `config.yaml`and`mcp.json` that people paste verbatim. An admin who set a hostile value could therefore have run commands on the machine of everyone who followed the setup instructions. The panel strips the same characters when it renders, so a value stored before this check cannot reach a snippet either; existing values are not rewritten.

- 4615fe8: `client` — caller attribution on every read and write.

  Every node write and every MCP tool call now accepts an optional `client` object naming the calling agent and its session, plus any custom scalar keys — create, edit, submit for review, approve, reject, revert, import (`POST /nests/import`, `POST /nests/unsynced/sync`) and bulk review on the REST side, every tool on the MCP side:

  ```jsonc
  {
    "title": "API Design",
    "content": "…",
    "client": { "agent": "claude-code", "session_id": "s-9f2" }
  }
  ```

  Submitting for review seals it into the engine's own version chain, since that is the entry a submission appends. Every other write that seals a version records it on that version, so version history — the REST list, `context_versions` (prose and structured payload alike), and the history panel in the UI — answers "which agent wrote v7, in which session". Every MCP tool call, and every REST call that accepts `client`, records it on the activity trace — which is where a call that seals no version is attributed: a read, and a rejection, which commits no content. The admin Activity Trace shows it under the caller it belongs to. `editedBy` is untouched and remains the authoritative authoring record.

  Everything about it is optional — the object and each field within it. No endpoint requires it, an unattributed call is a valid call, and a call carrying none stores nothing rather than an empty `{}`: "not attributed" and "attributed to nobody" are different claims.

  The server fills what the transport already knows under anything the caller sent, merged per key, so a caller that names its agent but no session keeps its agent and still gains a session id: `agent` from the API key's label, `session_id` from an `Mcp-Session-Id` header. `CONTEXTNEST_AGENT` / `CONTEXTNEST_SESSION_ID` override those; `CONTEXTNEST_NO_ATTRIBUTION=1` derives nothing, which matters because what is derived lands in an append-only history — consent has to be available before the first write, not after. Nothing is synthesized where the transport knows nothing: a placeholder session id would be indistinguishable from a real one.

  The field itself is the engine's: `clientField`, `clientMetadataSchema` and its bounds are imported from `@promptowl/contextnest-engine/api` and never restated here, so the CLI, the upstream MCP server and this edition all accept exactly the same `client`. This release therefore requires engine ≥2.6.0. Only the binding lives in this repo: what this server's transport can report about its caller, and how the block is stored on version rows and the activity trace.

  `client` is a label, not an identity claim: never authenticated, never used to authorize, and deliberately not an input to any hash chain, so histories recorded before the field existed keep verifying byte for byte. It is bounded (scalar values ≤512 chars, ≤16 custom keys) because an untrusted caller writes it into an append-only audit trail, and a near-miss on a reserved key (`sessionId`, `Agent`) is rejected rather than filed as a custom key — which would leave the write looking attributed while the slot readers check stays empty. It is distinct from `metadata`, which is frontmatter and describes the document rather than the call.

  Specified in `CONTEXT_NEST_SPEC.md` §9.4 upstream (PromptOwl/ContextNest#107); this is the Community Edition binding of it, over this server's own version rows and activity trace.

- a344cc5: New nest setting "Creators review their own documents" (`creator_is_reviewer`, off by default). In a governed nest, whoever creates a document becomes its reviewer steward and the first version publishes immediately; every later change — a teammate's or the creator's own — goes through review as usual, with separation of duties unchanged. Prime documents still start as drafts. Future creates only; nothing is stewarded retroactively.
- cd9b298: MCP writes behave the same on every nest, and match the engine catalog.

  - **`context_update` tags now replace the set** (the catalog's contract) instead of merging. Merging left no way to remove a tag over MCP. To add one, send the current tags plus the new one.
  - **Frontmatter pasted into `content` is refused** on `context_create` / `context_update`, with a message saying to pass tags/status as parameters. It used to be stored as a second, dead frontmatter block in the body.
  - **`context_move` returns `{ id, previous_id, title }` as structured data**, so `ctx move --vault <alias>` can read the result.
  - **One `/mcp` connection works for `ctx` across every nest.** The server-level tools now use the per-nest tool schemas plus a `nest` argument (the hand-kept copies had drifted, and undeclared keys were silently dropped). Reads that omit `nest` (`context_search`, `context_list`, `context_query`) return merged structured results, each hit tagged `nest: { id, name }`. Hits are interleaved round-robin across nests (search has no cross-nest relevance score), so a `limit` never fills up from the first nests alone. `context_overview` stays prose-only. `context_versions` is now served there too.
  - **`nest_index` returns the nests as structured data** alongside the markdown, which `ctx vault list` uses to list each nest as `<alias>/<nest>`.
  - **`/llms.txt`** documents registering the server once and addressing a nest as `--vault <alias>/<nest>`.
  - **`context_submit_review` takes `id`** on `/mcp` and no longer requires `title`, matching `context_versions`. A fan-out read that every nest rejects (a malformed selector, say) now returns that error instead of "No results found", and merged `list` / `search` cap their limits the way one nest does.

- 0cf46c2: Upload PDFs as governed `pdf` documents.

  `POST /nests/:id/nodes/pdf` (multipart `file`) turns a PDF into a document whose body is the PDF's extracted text — what agents read through `context_get`, which now also says `**Source file:** PDF, N pages` (and `no text layer` for a scan). The PDF itself is kept beside the document and bound to each version by sha256 (engine `context_import_pdf`, `@promptowl/contextnest-engine` 2.7). Uploads go through the same stewardship as any create or edit: a draft in a governed nest, a new version when the PDF is replaced. `GET /nests/:id/nodes/:nodeId/pdf` serves the binary through the node's read gate, so a public reader only ever gets the approved version's PDF.

  In the app: Import → "Upload PDF", or drop a `.pdf` on the vault. A PDF document shows the PDF in the browser's viewer above its extracted text (read-only), with Download and Replace PDF, and a warning when the PDF has no text layer. New setting `PDF_MAX_MB` (default 25).

- 5dc00db: Opening a nest to the Organization tier on a shared server now asks first — and says who it really reaches. Plus a "My nests" dashboard default.

  A nest's **Organization** visibility means every authenticated account on this deployment. On a self-hosted server that is your company, so the tier flipped in one click with the hint "everyone signed in here can read". On the PromptOwl-hosted service one server holds many unrelated customers, so the same click made a nest readable by every one of them — under a label that sounded like "my organization". Only **Public** confirmed.

  **A superadmin toggle names what the server is.** Settings → General → _This server hosts several organizations_ (`SHARED_DEPLOYMENT`, off by default, persisted like every other runtime setting, reported on `GET /health`). With it on, choosing Organization asks for the same acknowledgement Public does — and the server enforces it: `PATCH /nests/:id/visibility` to `org` without `acknowledge_public: true` returns `409 requires_acknowledgement`, so a client that bypasses the UI can't skip it either. The picker's hints and both dialogs then say the literal boundary: "every account on this server — other organizations included", and Public adds "including every account on this server". Off, nothing changes for a self-hosted install. Turning it on guards future changes only: nests already at Organization stay as they are until their admins narrow them — audit those first (the dashboard's _Organization_ scope lists every one).

  **The dialog shows what strangers will see.** Every confirmation — the visibility picker's and the nest header's publish toggle — displays the nest's description, since that and the name are all a reader discovering the nest gets, and offers to write one when it is empty. Optional; it never blocks the change.

  **Your nests first.** The dashboard opens on a new **My nests** scope (owned or shared with you) instead of everything you can read, so other people's org/public nests are a choice — _Organization_, _Public_ or _All nests_ in the same select — rather than the first screen. The choice is remembered per browser. `GET /nests` rows now carry `discovered: true` for nests reached through visibility alone, and **Shared with me** lists only nests somebody actually shared with you — a nest you can merely read because of its tier is no longer counted as one. A newcomer with nothing of their own sees "No nests of your own yet" with a _Browse all nests_ button, not "hidden by the current filter".

- cd2b02c: YouTube and Vimeo links play in place.

  Paste a YouTube or Vimeo URL on a line of its own and the document shows the video's player instead of a bare link — in the reader, version history, the artifact viewer and the editor (and its preview). The markdown on disk stays the plain URL, so agents, exports and the `/p` published pages see exactly what was written; published pages keep showing it as a link.

  Only a bare URL embeds: a titled link (`[Watch the demo](https://youtu.be/…)`) and a link inside a sentence stay links. Recognised: `youtube.com/watch?v=…`, `youtu.be/…`, `youtube.com/shorts/…`, `youtube.com/embed/…` (a `t=`/`start=` time is kept), `vimeo.com/<id>` (including unlisted `vimeo.com/<id>/<hash>`) and `player.vimeo.com/video/<id>`. Hosts are matched exactly — anything else, including look-alike domains, stays a link. YouTube plays from `youtube-nocookie.com`; the player runs in a sandboxed, lazy-loaded frame. For an unlisted Vimeo video, paste the share link that includes its hash (`vimeo.com/<id>/<hash>`) — without it Vimeo refuses to play the video.

  **Adding images and videos is obvious now.** The editor toolbar has a labelled **Image / video** button (icon-only on narrow screens) with two choices: _Upload image or video_ — with the accepted types and limits spelled out (PNG, JPG, GIF, WebP up to 10 MB · MP4, WebM up to 30 MB) — and _Embed YouTube or Vimeo link_, which checks the link and drops it in as its own line so the player shows (a link that isn't a YouTube/Vimeo video gets an inline error). Dragging a file over the editor shows "Drop to add an image or video"; pasting a screenshot or copied image uploads it the same way a drop does (before, a pasted image did nothing); and an empty document's placeholder mentions both. CSV / TSV import stays under the Upload button. None of this appears in a read-only, locked or preview document.

### Patch Changes

- 62cf2bc: An HTML artifact can be shared, published, linked, moved and deleted from its own page, the way a markdown document can.

  A markdown document's top bar has Share (the nest) and a ⋮ menu with Copy link, Move to folder, Share this document, Publish and Delete. An artifact — a slide deck, dashboard or infographic an agent emitted as HTML — opened in a viewer that had none of them: Preview / Annotate / Edit source, History, Reload, Turn into a document, Comments and Open in new tab. The server already published and granted access to artifacts exactly as it does documents; the buttons just weren't there, so sharing an artifact meant going back to the nest list and finding its row menu.

  The artifact page now carries the same visibility control, the same Share button and the same ⋮ menu, with the same gating — owners and admins share and publish, editors move and ask for deletion, viewers get Copy link, an archived nest withholds sharing — and a published artifact serves as HTML under the artifact sandbox as before. The two pages draw the menu from one list (`ui/src/lib/document-actions.ts`), so they can't drift apart again; that list is unit-tested for the role matrix.

## 1.24.0

### Minor Changes

- d367e2f: Account page. The account menu's single **Account** entry opens `/account`: your avatar initial, name (edit in place), email with the Admin badge, and password (opens the change dialog). It replaces the Change password menu item. Backed by `PATCH /auth/profile { name }` — trimmed, ≤ 80 characters, empty clears the name so the email shows.
- 4bf6f98: `POST /nests/:id/context` with a `prompt` returns the documents relevant to it, ranked — not the neighbourhood, and not the nest.

  **Bodies count.** The prompt compiler matched tokens against tag names and titles only, so a natural-language question ("how do I run a conflict check?") usually compiled to nothing and came back empty — which pushed callers into dumping the whole nest as a stand-in — or compiled to one weak title while the real answer sat in another document's body. Every document is now scored against the prompt (title hits weigh most, then tags, then body words), unioned with the compiled matches, and anything under half the top score is dropped as noise. A prompt that matches nothing — a greeting — returns `nodes: []`. `trace.compiled.fallback` is `"fulltext"` when body scoring alone produced the answer.

  **No hop noise by default.** A prompt used to inherit `hops: 2`, so every keyword match dragged in two hops of wikilink neighbours as full nodes, indistinguishable from the match — and a caller citing every node returned cited them all. The prompt path now defaults to `hops: 0`; pass `hops` to expand. Explicit `selector` requests keep their `hops: 2` default.

  **Per-node relevance.** On the prompt path each entry in `nodes` carries `score` (0–1) and `via` (`"title"`, `"tag"`, `"fulltext"`, or `"hop"` for a neighbour pulled in by an explicit `hops`). `nodes` and the `context` blocks are ordered by score. Additive: selector-path responses are unchanged.

  **The budget fills instead of stopping.** Budget-fitting used to stop at the first document that didn't fit, so one large document early in the list left the rest of `max_tokens` unused — a 38-document match could come back as one. A document that doesn't fit is now skipped and the next is tried; only when nothing fits at all does the best match go through oversized, so a non-empty result is never an empty answer. `GET /nests/:id/export?max_tokens=` fills the same way.

- 75f6147: The document page reads like a page, not a form.

  **An index beside the document.** Every nest you can see sits in a collapsible rail on the left, the current one opened into its views — Overview, Review queue (with its pending count), Board, Graph, Definitions, Workflows, gated the same way as the nest view switcher — and its folder → document tree with the open document highlighted, the same tree the nest's Documents tab shows. Moving between documents is one click; hide the rail and it stays hidden (per browser). On a phone the rail is a drawer.

  **One top bar.** Where you are (nest › folder, status) on the left; what you can do on the right: last-edited time, the nest's visibility — an owner or admin flips private / organization / public right there, with the same going-public acknowledgement as the Share dialog — Share, Comments, Compare, Submit for review, Save, and everything else in ⋮ (version history, markdown source, copy link, move, share this document, publish, discard draft, delete). The sticky footer and the Title / Tags / Content labels and boxes are gone: the title is the heading, tags are a quiet row under it, and the body is the page.

  **Click to write, select to format.** The body is prose until you click into it; the block toolbar appears with the caret and leaves with it, and highlighting text brings up the formatting bubble. The window scrolls, not a box inside the page.

  **Comments stay out of the way.** The comments rail starts closed instead of taking a third of the width to say "No comments yet", and opens from the top bar (with the open-thread count), for a deep link to a thread, on entering comment mode, or when you pin a comment to a selection. Its state is remembered per browser.

  **Fix: opening a document no longer says "Unsaved changes".** A document whose markdown didn't round-trip byte-for-byte through the editor — any document with a table — opened already dirty and wrote a spurious version on the first click-out. The editor normalising a freshly parsed table is no longer reported as an edit.

  **Turn into.** A document can now become an agent, skill, tool, table or hosted artifact after the fact — ⋮ → _Turn into…_ on the document page, and _Turn into a document_ on an artifact's page — where the type used to be fixed at creation. `PATCH /nests/:id/nodes/:nodeId` accepts `type` with the same gate as create; converting to a skill defaults its trigger from the title, and converting away from a runnable type drops its schedule.

  **The sidebar stays.** Leaving a document for the board, graph, review queue or definitions kept the index — it wraps every page inside a nest now, with the current view highlighted and Connect one row down, and the old tab strip only shows on phones or when the sidebar is hidden.

  **Definitions is just the table.** Rows edit in place (click one; Enter or Ctrl+Enter saves, Escape cancels), a new term is the last row, and the duplicate-term warning appears under the row you're on. No form above the table.

  On the dashboard the sidebar is the app's navigation — **Nests**, **My Work** and **My Drafts**, badges included — and each is its own page (`/`, `/my-work`, `/my-drafts`), so the tab strip above the nest grid is gone and a page can be bookmarked or shared. Each is its own component and chunk: opening `/` no longer fetches the inbox and drafts, and opening `/my-work` no longer fetches every nest — a page loads its own data when it opens, and the sidebar badges come from two one-row reads. Archived nests are a switch at the end of the Nests filter row instead of a fourth tab; the list, its filter/sort and restore are unchanged. Under a nest the sidebar keeps Overview and Review queue — with a badge when something is waiting — at the top, with Board · Graph · Definitions · Workflows folded under **Views** (remembered per browser, opened when you're on one of them).

  **Nest views have their own URLs.** Board, Graph, Definitions and Workflows are `/nest/<id>/board` … (the old `?view=` links still open), each its own page behind the same folder registry the dashboard uses. The header shows a breadcrumb — Home › nest › page, or the document's title — everywhere.

  **The nest page paints tab by tab.** Overview, Documents, Review, External Edits, Stewards and Collaborators each load their own data and show their own loader, so a slow disk scan for external edits no longer holds the whole page on one spinner. Each tab is its own chunk, loaded when first opened; so are the nest page, the editor and the settings pages.

  **External edits come from the database.** Staged external edits are recorded as they are staged (who, when, source, hashes) and the External Edits list and its badge read that table instead of walking every document in the vault — on a deep folder tree that walk was the slowest request on the page. Existing installs rebuild the table on the nest's next index refresh (migration 043). `GET /nests/:id/external-edits?count=1` returns the total only.

  **Fewer requests per page.** Opening a nest fetches its metadata once (it was four times), the sidebar tree loads one folder level at a time instead of the whole nest, comment counts load with the Documents tab rather than the Overview, and the Review-tab gate reads the comment feed only when nothing else already shows the tab. `/me/work` notification rows carry `nest_name`, so opening one needs no nest list.

  **Editing.** The toolbar is always visible in edit mode and sticks under the top bar; the Type control (Document · Artifact · Table · Agent · Skill · Tool) sits on the page for existing documents too — picking another type is "Turn into", with a one-step confirmation. Markdown source moved to the toolbar, Discard draft to the bottom bar beside Save. The artifact page shares the document page's layout: same top bar, padded column, and a comments rail that opens on demand.

  **Nest header.** Rename is a pencil beside the name; Import and New Document sit with New Folder on the tab row; a `+` on every sidebar folder creates a document there.

### Patch Changes

- 808d1d4: Archive requests in My Work use the same Approve / Reject buttons as review items. The two actions were a small outline button and a ghost link next to the green/red pair on review rows; both workflows now render the one shared pair.
- cfeb7b2: An archived nest hides the controls that could only fail. In the nest view: Connect, the Reader Mode switch, Activity trace, and Assign / Remove / Edit steward. In a document: the visibility dropdown becomes a read-only badge, and Share, Share this document and Publish are gone. Everything read-only — version history, copy link, compare, comments — stays.
- 56169a8: Sharing on an archived nest says it is archived. Opening a document's Share dialog in an archived nest showed the owner "Required permission: 'write', your permission: 'read'" — the archive cap in a permission's clothing — and offered a form that could only fail. Refusals on an archived nest now name the archive, and the dialog shows an archived notice with the add and remove controls gone; the existing roster stays visible for reference.
- 960b5cd: An archived nest still shows who its documents are shared with. The archive cap dropped the owner to read-only, which also locked them out of the sharing roster, so the Share dialog opened empty. Owners and admins can read the roster of an archived nest again; sharing and unsharing stay refused until the nest is restored.
- 9126dd0: An archived nest's owner is no longer told they cannot manage stewards. The steward gate read the archive-capped permission, so the owner (and the server admin) saw "You don't have permission to manage stewards" on their own archived nest. Standing is unchanged by archiving: the steward roster and the activity trace stay readable, and a change is refused as "This nest is archived".
- 4e5dfdd: Community sites say Enabled / Disabled instead of Active / Inactive. The badge only ever reflected the admin switch — the server never contacts a site (SSO tickets are verified locally with the shared secret), so "Active" implied a reachability it could not know. The switch's tooltip says the same.
- 3f32d34: `contextnest://` links in a document open like wiki links. A bare `contextnest://nodes/gtm/deals` in the text, or a `[label](contextnest://nodes/…)` link, now renders as a link to that page in the reader and the document view — click opens it, hover previews it. A `@checkpoint` pin or `#anchor` on the URI is ignored for resolution; tag, search and folder URIs have no page to open and stay plain text.
- 2ddfb74: Coverage Gaps no longer reports "Every category has a steward" for a nest with no categories. With nothing tagged there is no coverage to evaluate, so the row now says "No categories yet" (or "No categories or stewards yet" when the nest has no stewards either) instead of a clean bill of health.
- d18c3d6: Every nest now has its own URL: `/nest/<id>`.

  Until now a nest — public or private — was only reachable as `/?nest=<id>`, a query-string deep link into the app shell, so there was nothing clean to share, embed, or bookmark. The app now writes the path form for every nest-scoped view (documents, graph, workflows, board, trace keep their `?doc=` / `?view=` / `?tab=` parameters after it), and the document "Copy link" action produces it too. Old `?nest=<id>` links and the links in notification emails keep working: they resolve the same way and are rewritten to the path form on load.

- d367e2f: The document meta row separates creator and collaborators — `Created by <author> · Collaborators: <chips> N` — instead of running email, chips and count together. Adding a tag now confirms with a toast that names the tag and reminds that Save persists it. The comments rail header stays on one line so the Comment mode switch no longer sits below a wrapped label.
- 8244e5e: Document and nest page polish. The app header's breadcrumb row stays pinned while a page scrolls, with the document and artifact toolbars sitting flush under it. A document's outline moves from a card above the body to the right rail, giving way to Comments when they are opened. The comments rail has more room and a header rule; related-document lists separate titles with a dot. The nest Overview waits for the document tree before it can say "No documents yet". Artifacts stored as markdown or plain text keep their line breaks in Annotate and render as formatted markdown in Preview.
- 263665a: Three folder fixes in the nest view.

  **New Document lands in the folder you're looking at.** With the Documents tab scoped to a folder, the header's New Document button always filed the document under the nest root. It now defaults to that folder; the editor's folder picker still lets you change it.

  **Folder names keep their casing in the New Document picker.** The create-form breadcrumb and subfolder list rendered the raw storage slug (`a`) while every other surface showed `A`. They now use the same display name.

  **Empty folders show on the Overview.** The Contents card hid the folder tree until the nest had at least one document, so folders created first were invisible even though the folder count had moved.

- f571fd9: The Graph tab only offers layer toggles that have something to toggle. A nest with no stewards no longer shows a Stewardship switch or legend row, and the same goes for Categories and Links; Structure is always there.
- b3218ad: How it works is now a page-by-page tour of the app (nests, documents, review, views, workspace, admin) instead of a workflow-plane manual; the Docs page frames the agent manual for people and points them at How it works; /llms.txt covers folders, tables, versions, comments, the /me inbox and the full per-nest MCP toolset.
- 06d746f: Server Settings rejects a malformed product analytics key and says why. The PostHog key field saved any string, so a typo silently turned analytics on with a key that could never send an event. A key must now look like a PostHog project API key (`phc_` plus a long run of letters and digits); the inline message names the rule that failed — wrong prefix, stray characters, or too short — and nothing is written. Clearing the field still turns analytics off.
- 3f13e09: "Preview as reader" for nests with Reader Mode on. Owners and editors always saw the authoring view, so checking what visitors get meant a logged-out browser. The Reader Mode dialog now has a Preview as reader button that shows the visitor-facing reader in place — approved documents and approved text only, exactly as a visitor sees them — with an Exit preview bar to return to the authoring view. Rights are unchanged while previewing.
- c0a0911: Reader Mode shows the whole nest on first load. The public reader fetched only the root level and the first top-level folder, so every other folder sat collapsed until a visitor clicked it, and a home page that lived in a later folder never resolved — the reader opened empty. It now reads the nest's document list in one metadata-only request, lists every folder expanded, and opens the designated home page wherever it lives.
- fe47446: Reader Mode is laid out as three cards that scroll on their own. The contents, article and "On this page" panels fill the window below the header and each scrolls internally, so the page never scrolls as a whole; the nest name heads the contents as a proper heading with a search box under it; the outline lists every heading of the open page, indented by level, exactly as the editor's outline does; Previous / Next are proper buttons after the article; and long nest, page and folder names truncate with a tooltip instead of stretching the layout.
- 04bc5b3: Reader Mode's contents panel has a search box. Type part of a page title or a tag (with or without the `#`) and the tree gives way to the matching pages with their folder; clear it to get the tree back.
- c0a2e6b: Reader Mode's contents and "On this page" columns share one height. Each column sized to its own content, so the hairlines framing the article ended at different points on every page. Both now take the same viewport-based height and scroll internally.
- 9b9b250: "Request archive" shows its own spinner. In the nest removal dialog, pressing Request archive spun the Request deletion button instead — the dialog had one busy flag and always drew the spinner on the primary action. The spinner now follows the button that was pressed.
- d367e2f: The document sidebar filters nests by name. The rail listed every nest flat with no way to narrow it; a small filter above the list (shown when there is more than one nest) does what the dashboard's filter already did. The current nest is never filtered out.
- 68eb09b: UI neutrals move from warm stone to zinc so the sidebar and cards sit in the same family as the navy primary; both sidebar rails (app pages and a nest's views and tree) share one row style — same text size, icon size, height and spacing — and idle rows read darker.
- 283b90d: Wiki links inserted from the editor carry the document's full path. The `[[` picker and the link dialog wrote `[[nodes/<slug>|Title]]` with the folder dropped, so a link to a page inside a folder pointed at a path that did not exist and only resolved by luck of the slug. They now write the full node id; existing short links still open through the slug fallback.

## 1.23.0

### Minor Changes

- 0976b51: An agent can answer a comment, not just read one.

  **Comment writes over MCP.** `context_comment` leaves a comment on a document — a new thread, or a reply into an existing one when given a thread id from `context_comments` — and `context_resolve_comment` marks a thread resolved or reopens it, recording who did it. They write to the same threads the web UI's comments panel shows, and carry the same side effects a comment left in the UI does: the person you `@`-mention is notified, and an artifact's derived `— Annotations` projection stays current. Commenting is read-tier, here as in the REST API, so a reviewer who can see a document can comment on it.

  **Comments are readable from the cross-nest endpoint.** A client connected to the server-level MCP endpoint asking for a document's comments used to get `Tool context_comments not found` — for every node type. It's now declared there like the other read tools, nest-parameterised. (Writes stay on the per-nest endpoint.)

  **A collaborator can read comments on their own unapproved draft.** `context_comments` used to gate on the same "no approved version → invisible to AI" rule as `context_get`/`context_export`, so a document with no approved version refused its comments to everyone, including the collaborator or steward who wrote it and can already see it in the UI. It now gates on per-node read access instead (`canReadNode`), matching the UI: a collaborator or steward who can read the node reads its threads even pre-approval, while a public reader — who couldn't see the draft either way — stays blocked until approval.

  **A thread's replies keep their order.** Comment timestamps were stored to the second, with a random UUID as the tiebreaker, so two replies posted inside the same second came back in arbitrary order — in the thread and in the projection an agent reads. They're now stored to the millisecond. Existing comments are untouched and still sort correctly against new ones.

- a71498b: Tag people in comments, and stop retyping addresses to add them.

  **`@mentions` work in comments.** The comment box gets the same `@` autocomplete the document editor has, listing everyone who can reach the nest, and a posted comment's mentions are styled — resolved names as live references, a name matching nobody drawn as unresolved, so a typo can't pass for a delivered mention. The roster read behind it is read-tier (commenting is), so a read-only reviewer's picker works too; it stays members-only, so a nest that is public or org-visible still doesn't hand its member list to a passing reader.

  **A tagged person actually hears about it.** Tagging someone in a comment now drops a row in their queue that links to the document, posts to the configured Slack/Teams/webhook connector, and emails them directly when SMTP is set up. Previously a comment mention notified nobody: the fan-out was wired to document saves only. Mentions in a document body reach the same channels — they used to be inbox-only. One write notifies at most 25 people, and one person can cause at most 50 outbound deliveries per nest per five minutes, so neither a comment naming a whole roster nor a stream of them can be used as an amplifier. Past the limit the comment still posts and the queue row still lands — only the email and channel message are skipped. The author is never notified about their own mention, an unresolvable name notifies nobody, and someone who can't open the document is skipped — a mention can't disclose a title. A mention in a comment on a hosted artifact now points at the artifact rather than at its derived annotations projection, and fires once instead of twice.

  **The suggestions are scoped, with a toggle for servers that are one company.** By default the add-a-person fields only suggest people the inviter already shares a nest or team with — a server can host several unrelated organisations, and a full directory would show them each other's email addresses. An operator whose user table is their own staff can turn on **Settings → General → People directory → "Suggest everyone on this server"** (`PEOPLE_SUGGEST_ALL_USERS`) and get the whole directory. Neither setting changes who can be invited: an address that appears in no list is still valid to type.

  **Adding people and teams autocompletes.** The add-a-person fields (nest collaborators, stewards, team members) suggest people you already work with — anyone on a nest or team you share — while still accepting a brand-new address, so inviting someone without an account works exactly as before. Team pickers (share a team onto a nest, add a team from the collaborator panel) are searchable instead of a flat dropdown.

  With that toggle on, the `@` pickers (comment box and document editor) offer the whole directory too, and tagging someone who isn't on the nest adds them as a **read** collaborator before notifying — so the mention is an invite, not a dead tag. Only a write+ author can invite this way: a read-only reviewer's mention of an outsider still reaches nobody.

  Per-nest connectors can now subscribe to the `mention` event (alongside the review and run events), and the channel delivery budget is only charged when a connector would actually post that kind.

- 3b39d4f: Manage multiple official community site SSO connections from Server Settings, instead of just one.

  Server admins previously configured a single official community site for one-click SSO auto-login via the `OFFICIAL_COMMUNITY_SSO_SECRET`/`PUBLIC_BASE_URL` env-var pair. **Settings → Community sites** now lets an admin add, edit, enable/disable, and remove any number of sites, each with its own name, URL, and secret (`GET/POST/PATCH/DELETE /admin/community-sites`, server-admin only — see `API.md`). `GET /auth/sso` tries an incoming ticket's signature against every active site's secret and validates its audience against this deployment's own `PUBLIC_BASE_URL` (a site's URL is a display/uniqueness field, not an audience value), so a ticket minted for a different deployment can't be replayed here.

  The legacy env-var pair still works as an implicit extra site, so existing single-site deployments are unaffected — nothing to migrate.

### Patch Changes

- 43fcdef: Fix a stuck organization-visibility toggle and close UI gaps around archived nests.

  The header's quick visibility toggle could take a private nest to organization or public, but couldn't walk an organization nest back to private — it only offered escalation to public. It now routes an organization-visibility nest to the Collaborators tab, where all three tiers (private/organization/public) are available.

  Archived nests are read-only everywhere writes are gated on `deriveNestCaps`/`resolveEditorAccess`, not just on the nest and document list: the Board's new-folder input and drag-to-move, the Definitions page's add/edit/delete term UI, and the document editor's Save/Submit/Discard/Revert and delete controls all now stay hidden on an archived nest regardless of how it was reached (dashboard, deep link, wiki link, or a page refresh). The Archived tab itself now sorts by archive date instead of creation date, and opening a nest from that tab correctly reflects an anon-owned nest for a caretaker admin.

  Server-side enforcement (an archived nest 403s any non-GET) was already correct; this closes the remaining UI-side gaps so the affordances never appear in the first place.

  Public Docs Reader Mode also rendered empty for any nest whose documents live under a subfolder (the common docs-site shape): the reader only ever showed the root level fetched on mount, with no way to expand into a subfolder. NestView now eagerly fetches the nest's first top-level folder alongside root when reader mode is on, and Reader Mode's folder rows fetch their own level on click, reusing the same lazy per-folder fetch the Documents tab already relies on.

  Two further Reader Mode fixes: the home/overview pane no longer duplicates the center pane when the reader is already viewing the home document itself (it falls back to the Contents table instead), and the left folder list and Contents fallback now cap their height and scroll internally — matching the document viewer's existing behavior — so a long list no longer misaligns the three panes or forces the whole page to scroll.

  Three more Reader Mode fixes: navigating to any document left no way back to the overview/home doc — the center pane now shows a "Back to Overview" link whenever the reader is away from the home node. A folder in the left pane, once opened, could never be collapsed back, permanently eating vertical space — folder rows are now a collapse/expand toggle (defaulting open) with a chevron indicator. And the left folder list, center document, and right overview/contents panes now all share the same min/max height so the three columns line up instead of drifting out of alignment.

  Fixed one more Reader Mode issue: every known folder's chevron defaulted to the "expanded" (down) icon even when its documents hadn't been fetched yet, so unopened folders looked open but showed nothing underneath. A folder's row now only defaults to expanded once its docs are actually loaded (root and the eager first-level folder); every other known folder defaults collapsed until clicked, so the icon always matches what's on screen.

  Public Docs Reader Mode could previously only be turned on by the server (super) admin — a nest's own owner had no way to enable it for their own nest without asking an operator. `PATCH /nests/:id/reader-mode` and the "Reader: On/Off" button now also accept the nest's owner or an admin collaborator, on top of the server admin (who keeps access on every nest, same as before). A write or read collaborator, and anonymous visitors, remain refused.

  Fixed a bug in the "My Work" Notifications panel where it always showed only the first 8 of the up to 50 unread notifications the server already fetches, with no way to reach the rest — clearing one of the visible 8 just pulled the 9th into its place, so the panel silently stayed capped at 8 forever. The panel now shows a "Show all (N)" toggle whenever there are more than 8, expanding to the full fetched list in a scrollable strip; "Show less" collapses it back to the compact 8-row preview.

  Opening a notification (not just the per-row dismiss button) now marks it read too, so it drops out of the panel's unread-only list instead of staying there after being clicked — matching the dismiss button's behavior via a shared `dismissNotification` helper. The mark-read call already refreshes the cached `/me/work` read for any other consumer subscribed to it, so the notification stays gone after a refetch, not just in the local list.

  Fixed the Documents tab's "Tags" and "Recently edited" facet bars showing stale, unfiltered data: they were always computed from the nest-wide census, so applying a status/type/author/date/search/tag filter narrowed the document list below them without touching the facets above it. Both now derive from the same filtered list the document list itself renders, so they narrow together — down to hidden when a filter matches nothing. The Overview tab's own "Recently edited" card is intentionally unaffected, since it has no filter of its own and is meant to summarize the whole nest.

  Fixed the owner/admin notification for a pending **Request archive** ask, which still said the nest was "flagged for deletion" — deletion wording left over from the shared code path a `nest_archive` request rides. The `/me/work` inbox row (and the underlying Slack/webhook connector message) now says the nest "was requested to be archived by <user>", matching the archive terminology already used elsewhere in this flow (the queue badge, the verdict notification once the request is honored). A real node/folder deletion request is unaffected — it still reads "flagged for deletion".

  An editor could already ask for a nest to be archived or deleted from NestView's overflow menu, but the same option was missing from the Dashboard's nest cards — an editor without NestView open had no way to raise the request at all. The card grid's bin icon now does double duty for a caller who isn't allowed to delete outright (an editor, or a non-owner nest admin): instead of deleting, it opens the same "request archive or deletion" dialog NestView offers, posting to the same endpoint. A caller who can already delete outright still gets the direct delete confirm, unchanged.

  Fixed two more bugs in the archive-request flow QA found while re-testing: declining a pending `nest_archive` request told the requester "delete request rejected" — the reject verdict never made the same archive/deletion split the request and approve verdicts already made, so an archive ask that was turned down read as a deletion. It now says "Your archive request ... was rejected". Separately, the original "was requested to be archived" notification stayed unread in every admin's inbox forever, even after the request had been resolved (approved or declined) — it now gets marked read for everyone the moment the request is resolved, instead of only when someone happens to click it directly.

- 6bc359e: Fix Board tag-column casing, a stuck Board add-column input, slow Board loads, raw-email mentions, a silent rename-cancel, missing Archived tab controls, and run-on validation/status messages.

  The Board's **Columns by = Tag** column headers applied CSS `text-transform: capitalize` unconditionally, so a lowercase tag like `annotations` showed as `Annotations` in the header while the card's tag chip stayed lowercase. Tag headers now render the tag value verbatim, matching the chip; Folder and Status headers are unchanged.

  The Board's add-column input is shared between Folder and Tag mode. An unsubmitted value typed in one mode (entered but not confirmed with Add) used to carry over when switching **Columns by**, showing a tag string in the folder input or vice versa. Switching dimensions now clears the input.

  The Board's node fetch asked for every document's full body (`content=1`), which forces a vault crawl on every load and refresh — expensive on a large nest, and wasted, since the Board only buckets nodes by tag/folder/status and never reads a body. It already covered the whole nest (tag columns were never scoped to a folder), so this was a pure loading-time fix: the Board now fetches a metadata-only, body-free listing served straight from the node index, same source the document tree already uses.

  An `@mention` picked from the `@` autocomplete saved as `@user@example.com`, which the read-only document viewer had no handling for — `remark-gfm`'s email autolink turned the domain half into a `mailto:` link, leaving the mention's `@` as a bare character next to a clickable full address. Mentions now render as a single `@name` chip, matching the live editor's styling, with no link and no exposed email. The live editor itself had the same leak: its mention decoration only added a CSS class to the raw text, so the full email stayed visible while editing even though the read view was fixed. It now hides the `@domain` remainder the same way `[[WikiLink]]` brackets are hidden today, showing just `@localpart` in both places.

  Pressing Escape during an inline nest rename reverted the title on screen but still saved the edited name underneath: the revert was a batched `setState` that hadn't applied yet when the input's own synchronous `blur()` fired the pending save. Escape now cancels the save along with the visual revert, so the original name stays persisted.

  The Archived tab was a flat list with no way to search or sort, unlike the live Nests tab. It now offers a name filter and a "Date archived / Name" sort, shown once there are more than 5 archived nests, matching the live tab's own threshold and affordances.

  The workflow-cycle rejection message ("These steps loop back on each other: ... A flow can't return to a step it already ran.") and the Version History "Never published" hint each ran the specific result and the general explanation together as one sentence. Both now put a line break between them for easier scanning; no wording changed.

  The Board's **Columns by = Tag** view rendered zero columns on a nest with many tags: the tag board is user-curatable (adding/removing a column persists an explicit, exhaustive `columnOrder`), but a nest nobody had curated yet had no saved `columnOrder` at all, and an empty/undefined order was being treated as "curated to nothing" — so every tag in the nest was there in the data but none of it had a column to land in. A fresh tag board (no saved `columnOrder` yet) now auto-populates a column for every tag actually present, exactly like Folder and Status already do; it only switches to the curated, exhaustive-list behavior the moment the user adds, removes, or reorders a column, which is unchanged and keeps any already-curated board exactly as it was.

  The `\n\n` added to the workflow-cycle rejection message split the string, but the message is displayed inside a plain `<div>`/`{error}` text node in `WorkflowsView.tsx`, and the browser's default `white-space: normal` collapses newline characters like any other whitespace — so the two sentences still rendered on one line despite the source string having a line break. The two error containers that can show this message (the Edges tab's inline error, and the workflow canvas's connect/save error) now add `whitespace-pre-line`, which preserves `\n` as a line break while still collapsing ordinary runs of spaces/tabs, so the existing `\n\n` in the message now actually renders as a blank line between the cycle path and the explanation.

  The workflow-cycle rejection message's `\n\n` was later collapsed back down to a single `\n` in `edge-routes.ts`/`flow-graph.ts`, which silently undid the line-break fix above (the `whitespace-pre-line` CSS had nothing to split on) and left `test/edges.test.ts`/`test/edge-types.test.ts` asserting a `\n\n` the source no longer produced. Restored the double newline in all three throw sites so the rendered line break and the tests both match the source again. Also added `aria-hidden="true"` to the live editor's hidden `@domain` decoration so the masked part of an email mention is skipped by assistive tech, not just visually hidden.

- e190cb6: The Connect dialog's client tabs stopped asking for two copies where one would do, and stopped showing two different clients the same block.

  **MCP tab is one paste again.** It used to show the endpoint and the `Authorization` header as two separate snippets, each with its own Copy button — a user had to copy both and hand-splice them into their client's config. They're now one `mcpServers` JSON stanza with a single Copy button, the same shape Cursor and VS Code already expect.

  **Claude tab and MCP tab no longer look identical.** Merging the MCP tab into one JSON block gave it the same `{ "mcpServers": { ... } }` envelope the Claude tab already used, so the two read as the same content pasted twice, even though they target different transports — Claude Desktop only speaks stdio and bridges through `mcp-remote`, while the MCP tab is direct Streamable HTTP for clients that support it natively. Each snippet is now labelled with the client it's actually for.

  **Claude Code gets a one-shot command instead of a file to edit.** The Claude tab only ever showed Claude Desktop's `claude_desktop_config.json`, hand-edited and bridged through `mcp-remote` — but Claude Code (the CLI) registers and persists an MCP server itself, with no file to open. The tab now leads with `claude mcp add --transport http <nest> <url> --header "..."` as the primary path; the file-based Claude Desktop config stays below it as a clearly separate option for the GUI app, which has no CLI.

  Key generation is unchanged — still a separate step on the API Keys page, not inlined into the modal, since an account can hold multiple keys and there's no single one to pre-fill here.

- b86acc1: Fix a nest's document count drifting above the number of files it holds.

  Commenting on an artifact creates the derived `— Annotations` node that carries the feedback into the context path. Every listing hides it — that is the point — but three counts didn't: the dashboard card, the dashboard's running total, and the document count MCP's `nest_index` reports to an agent all counted it as a file. So a nest read one document high per commented artifact, and the gap never closed, which looks exactly like a stale cache.

  The exclusion is also case-correct and consistent across backends. SQLite's `LIKE` folds ASCII case and ignores collation, Postgres's doesn't — so a document imported from a file named `Deck--Annotations.md` (imports keep a file's case in its id) was dropped from the count on SQLite and kept on Postgres. It is a real document either way, and now counts on both.

  The card's "recent activity" still reflects a comment — a comment is activity on the nest, even though it isn't a file. A document a person actually titled something ending in "Annotations" is still a file and still counts.

## 1.22.0

### Minor Changes

- 2bc8689: My Drafts can submit a selection for review in bulk, alongside the existing bulk Discard. The submit dialog covers one draft or many, and a batch where some submissions fail reports both what landed and what didn't.
- 1c1071e: Add the `org` nest visibility tier — readable by everyone signed in to this deployment.

  **The missing middle.** Nest visibility was `private` or `public`, so sharing a nest company-wide meant adding every person as a collaborator or opening it to the internet. `org` is the tier in between: any authenticated user of this deployment can read it; anonymous callers still get nothing. Community has no tenant model and teams are a group you _attach_ to a nest rather than an org boundary — a self-hosted install already IS one organization, so deployment membership is the boundary. `PATCH /nests/:id/visibility` accepts `org`, and unlike `public` it needs no `acknowledge_public`: it crosses no organizational boundary. Like public readers, org readers see approved content only.

  **Discovery follows access.** An org nest joins the readable union and the discovery listing for an authenticated caller, and neither for anon — an org nest nobody could find would be reachable only by a passed-around link, which is not what "available to the organization" means.

  **The migration rebuilds `nests`, carefully.** SQLite cannot alter a CHECK constraint in place, and `nests` is the most-referenced table in the schema: 27 tables point at `nests(id)`, every one `ON DELETE CASCADE`, on a connection that runs `foreign_keys = ON`. A plain `DROP TABLE` would take every node-index row, version, steward, grant and run with it — verified, not theorised: with the pragma left on, a control run deleted every child row. So `041_nest_visibility_org` toggles `foreign_keys` **outside** the transaction (the pragma is a no-op inside one), derives the replacement table from the live schema rather than a hardcoded column list (other branches add columns to `nests`, and a stale list drops them silently), and refuses to record itself unless `PRAGMA foreign_key_check` comes back clean. Postgres needs none of it — its constraint swap is catalogue-only.

  **The UI can set the tier, not just report it.** The visibility control (Collaborators tab and Share dialog) is now a three-way select — Private / Organization / Public — with the acknowledgement dialog still guarding the `public` choice alone. The nest header keeps its two-state shortcut for the common private ↔ public flip, and every surface that showed a visibility label — header badge for viewers, dashboard card badge, dashboard access filter — now knows the third value. Previously anything that was not literally `public` rendered as "Private — only people added below can see this nest," which for an org nest told the owner the opposite of the truth.

- 2bc8689: Optional PostHog product analytics, off by default. Set `POSTHOG_KEY` / `POSTHOG_HOST` by environment or from Settings → Advanced to point an instance at your own project; the browser only receives the key while `TELEMETRY_ENABLED` is on, so that switch still governs everything the server sends outward. posthog-js loads only when a key is configured.

### Patch Changes

- 1105713: Fix archive request copy: an archive request no longer reads as a deletion in My Work — it shows an ARCHIVE badge, an Approve action, and an archive confirmation instead of "Delete document".
- c857fe1: A partly-failed bulk submit for review now retries only the drafts that failed. The dialog previously kept the full original selection, so a retry resubmitted documents already in review and reported them as failures.
- 2bc8689: Clearer document and folder messaging: Version History no longer says saving publishes a draft (Submit for review does), the tag input says a tag was "adjusted" rather than "simplified", and the folder-creation toast names the folder the way the Contents tree does. An unresolvable `?nest=` link now renders inside the app shell, with the header and navigation still in reach, instead of a bare full-page error.
- 2fb9242: Give the agent setup prompt failure branches, so a first read that fails is recoverable instead of terminal.

  Copy the "Set up an agent" prompt into a coding agent and, if anything goes wrong, it used to have one instruction: stop. That is the wrong answer on an unlicensed server, where the documented first call is blocked but the nest is still perfectly readable — and it is the wrong answer in a sandbox whose network policy blocks the host, where retrying can never help.

  The prompt now branches on what actually came back. **503** means the server has no licence, so it points at `GET /export?format=markdown`, which is not gated and returns every document with its text in one call. **401** means the key is wrong or was never expanded from the environment. **403** distinguishes the server refusing you — usually a key scoped to another nest, which you can fix — from a gateway refusing on your behalf, which you cannot. **No response at all** means the environment cannot reach the host, so the answer is a connector your client dials server-side rather than another attempt.

  Three smaller corrections come with it. The key is now located (`CONTEXTNEST_API_KEY`) rather than merely requested, since the old copy asked the agent to ask for it while forbidding it in chat and naming no other channel. Write capability is stated only where it is true — on an unlicensed server writes are blocked along with everything else non-GET, and claiming otherwise made agents distrust the rest of the brief. And the prompt no longer tells agents to assume a `nodes/` id prefix, which exists on nests created in the app and not on imported ones; it says to reuse the id exactly as the server returned it.

- 2bc8689: Browser Back can no longer slip past the editor's unsaved-changes prompt: repeated presses are matched by the guard, and a second Back keeps the dialog already being answered instead of replacing it.
- 2bc8689: Workflow cycle errors read in plain language instead of "flow edges must form a DAG", and when two cards share a title the trail writes each one with its node id so every step names a single card.

## 1.21.1

### Patch Changes

- **Fix the notification inbox returning a 500 on Postgres.** On a Postgres deployment, `GET /me/work` and `GET /me/notifications` failed with `syntax error at or near ")"`, so the inbox and the work list were empty for everyone.

  The cause was in the `?` → `$1` placeholder translation. The scanner skips a `?` inside a quoted string literal so a literal is never rewritten, but it did not know about SQL comments — and an apostrophe in an ordinary English comment ("there's no request row") read as the opening quote of a literal. Every placeholder after that point was left as a bare `?`, which Postgres parses as an operator rather than a parameter.

  The scanner now skips `--` and `/* */` comments whole, so prose in a query can contain apostrophes without disarming the placeholders that follow it. SQLite deployments were never affected, since they take `?` natively.

## 1.21.0

### Minor Changes

- 0170c42: Drafts can be thrown away, and My Drafts can be managed at scale.

  **Discard a draft.** Every document with unreviewed edits now offers Discard: the document goes back to its last approved version, and the edits are gone. A document that was never approved has nothing to fall back to, so discarding it deletes it — the confirmation says which will happen. It is refused while a review is pending; reject the review first. Reachable from three places, because the moment you decide an edit was a mistake is rarely the same place twice: the document's own action bar, its version history panel, and My Drafts.

  **Drafts no longer add versions.** This is what made Discard possible. A draft save used to append to the document's version history, which is append-only and hash-linked — so a draft, once written, could never be taken back, and a long editing session left a trail of versions nobody wanted to read. Unreviewed work now lives in the document itself, and a version is recorded when the draft is submitted for review, and again when it is published. Version history is a record of what was released rather than of every save, and discarding costs no version at all. Existing documents are unaffected: nothing is migrated, old history stays exactly as it was, and the versions already in it remain readable.

  **My Drafts is a list you can work.** Alongside Submit for review, each row now has Discard, rows can be selected in bulk and discarded together, and the list can be searched by title or nest and sorted by title or by most recently edited. `GET /me/drafts` takes `q` and `sort` to match.

  **The document editor's write actions moved to a sticky bar** at the bottom of the page, holding Save, Submit for review and Discard, with the unsaved-changes marker beside the Save it refers to. A document takes minutes to fill in and runs well past one screen, so Save used to scroll out of reach exactly when it was wanted. The header keeps what describes the document rather than changes it — the review verdict, the version comparison, the secondary menu — and no longer repeats the document's name in the breadcrumb, which the title field directly below already shows.

- 018255c: `@mention` now picks a real person.

  Typing `@` in a document opens the same autocomplete `[[` uses, listing everyone who can reach the nest, and picking one writes their address into the text. An `@name` matching nobody on the nest is drawn muted and dashed with a "no member named X" tooltip, the same way a broken `[[wiki link]]` is, so a typed name is no longer indistinguishable from a real reference.

  "Everyone who can reach the nest" is a wider set than the collaborator roster: the owner, the members of a team the nest is shared with, stewards, and holders of a document or folder grant all reach a nest without holding a collaborator row. `GET /nests/:id/collaborators` now returns that union alongside the roster as `people`, each entry carrying the path that lets them in. The roster itself, and the Collaborators tab that manages it, are unchanged.

  Being mentioned now tells you. Saving a document drops an inbox row — the same place review requests and invites land — for everyone the save newly names: "someone mentioned you in "Doc"", opening straight to the document. Only new names notify, so the same mention surviving a dozen saves is one event; a name matching nobody notifies nobody; authors don't hear about mentioning themselves; and a mention only reaches someone who can actually open the document.

- 5505c0f: **Archive a nest instead of deleting it.** Delete was the only way to get a finished nest off the dashboard, and it takes the documents and the whole version history with it — so people either kept the clutter or destroyed something they might still need.

  Archiving is the reversible middle ground. The nest keeps every document, version and steward assignment, and leaves every surface it used to appear on: the dashboard grid, cross-nest search, the work inbox, My Drafts, the MCP nest index — and MCP by id too, so a pinned nest id or a nest-scoped key stops answering rather than quietly feeding an agent from a nest you put away. Published `/p/` links stop resolving, trigger hooks stop firing and schedules stop creating runs, so an archived nest genuinely stops working rather than only disappearing from view. It stays readable in the web UI, so you can check what is in there before restoring or deleting, and nothing at all can be written to it — the owner included, in both key and open auth modes.

  A new **Archived** tab on the dashboard lists them and restores them, after a confirmation. Restoring puts everything back exactly as it was, links included.

  Archive sits inside the delete dialog rather than in a menu of its own: someone reaching for Delete is deciding whether they still need the nest, and that is where the reversible option belongs. Editors, who cannot delete a nest, can now ask for one to be archived from the same request dialog they use to ask for it to be deleted — same queue, same reviewers, and honouring it archives rather than destroys.

- b736d7b: **Pin the nests you actually use.** On an account with many nests, the same few get opened over and over, and the only way to reach them was to sort or search for them every time. Any nest you can see now takes a pin, and pinned nests lead the dashboard grid under either sort — so they are always in the first screenful, whatever the page size.

  A pin belongs to a person, not to a nest: two people sharing one nest keep their own, and nobody can see anyone else's. It needs no write access either — a read-only collaborator is the likeliest person to be watching a handful of nests they cannot edit, so pinning is the one card action everybody gets.

  Pins follow the account rather than the browser, so they are there on your laptop too, and `⌘K` orders its nest rows the same way — pinned matches first, though a pin never promotes a nest that did not match what you typed.

### Patch Changes

- 13c7eaa: Seven UX fixes across search, tags, deep links, publishing, stewardship guidance, workflow errors, and nest names.

  **Esc closes Search from anywhere in the overlay.** The overlay advertises the shortcut but only honoured it while the search input held focus, so clicking the scope toggle or the "search all nests" link left Esc doing nothing.

  **An accented tag keeps its word.** `café` was stored as `caf` — the accented letter was dropped whole rather than folded to its base. It now becomes `cafe`, and the rewrite is still stated inline. Tags remain ASCII, because that is what the engine stores, so a script with no ASCII base is still refused rather than mangled.

  **A nest link that doesn't resolve no longer sticks in the address bar.** The dead id stayed in the URL behind the error screen, so refreshing — or sharing the address off it — landed on the same dead end. The error screen keeps its retry.

  **Publishing says it worked.** The new link appearing was the only signal, and on a long form it was easy to miss.

  **The stewardship note links to the setting it names.** The Collaborators tab told readers to turn on the approval workflow in nest settings without a way to get there; owners and admins now click through, and everyone else is told who can.

  **A rejected workflow connection names the cards, not their ids.** A cycle was reported as a list of internal node identifiers that appear nowhere on the canvas; it now reads as a trail of document titles.

  **Nest names are capped at 100 characters.** Any length was accepted, and a long one broke the card and list layouts that render it. The limit is enforced wherever a nest is named — created, renamed, or imported — and stated in the create form as the name is typed.

- ee9ba7a: Surface `ctx vault add` everywhere, pass the CLI key through the environment, and make MCP `context_search` as fast as REST search.

  **The ctx CLI is a first-class way in.** CLI 2.2+ can read a hosted nest directly — `ctx vault add <alias> --url <server>/nests/<id>/mcp --bearer-env CONTEXTNEST_API_KEY`, then `ctx query "#tag" --vault <alias>` — but nothing in the product said so. The Connect dialog now shows that snippet on both the MCP and CLI tabs (key placeholder only, never key material), `/llms.txt` gains a "From the ctx CLI" section covering the server-level `/mcp` alias and the per-nest form, the README's agent-serving bullet mentions it, and the "Set up an agent" prompt (`nestSetupPrompt`) adds the alias under its shell bullet. A new pure helper, `ctxCliConnectSnippet(serverUrl, nestId, alias, openMode)`, builds the lines; in open mode there is no `--bearer-env` at all.

  **The key never goes on argv.** The setup prompt told agents to run `push … --key <key>`, on the strength of a stale note that ctx read no API-key env var (true of CLI 1.2.1, not since). The CLI's own README says the opposite, and a key on the command line lands in shell history. The prompt, and the CLI tab's push snippet, now use `CONTEXTNEST_API_KEY=<key> npx -y @promptowl/contextnest-cli@latest push …`. `allNestsChatPrompt` is unchanged.

  **MCP `context_search` no longer times out on a large governed nest.** `ctx search --vault <remote>` hit the CLI's 30s `REMOTE_TIMEOUT` on a 444-node nest while `GET /nests/:id/search` answered instantly. The tool was resolving the access-gated, approved body of _every_ document in the nest — a permission lookup, an approved-version read and a version-chain reconstruction per node, all at once — before matching a single term. It now runs the exact REST path: match against the cached discovery set (title hits ranked first, like REST), gate only the hits with `filterAccessible`, and resolve gated bodies for the returned page alone. Same documents, same order, same access rule as REST. The tool takes an optional `limit` (default 20, max 200) and returns `count` alongside `results`, so a capped page can't read as the whole answer. Bodies stay gated exactly as before: under stewardship a hit with no approved version is listed (REST lists it) but carries no body.

- 8b533f0: **Search inside a nest waits for a query instead of listing the nest.** Opening the palette in a nest immediately listed every document in it, which read as a search that had already run — and the same overlay in a nest with nothing in it read "No matches" on an empty query. Both scopes now invite a term first, the way the all-nests scope always has.
- Fixes across the editor, publishing, tags, workflows and imports that shipped without a changeset of their own.

  **Leaving a dirty document always asks.** The unsaved-changes dialog was wired only to the editor's own back arrow and breadcrumbs, so the app header — logo, nav tabs, account menu — walked away from unsaved edits in silence, and browser Back fell through to the browser's own alert. Every view change now routes through a nav guard the mounted screen registers, and the editor parks a spare history entry while dirty so Back arrives as a popstate it can answer with the same dialog. `beforeunload` still covers reload and tab close, which no page can style.

  **A restored local draft says so.** Reopening a document put parked edits back with nothing to distinguish them from the saved version. A banner now names when they were parked and offers to discard them.

  **The editor listens for permission changes.** Assigning a steward, changing a collaborator or toggling stewardship did not reach an open editor until the page was reloaded — it had copied the three permission reads into state on mount, so it kept whatever rights the caller held when the document was opened. Those reads are subscriptions now, and an invalidation repaints the editor.

  **Publishing can't mint a dead link.** The dialog minted a link for a document with no approved version and the reader got "Link unavailable", because `/p` serves the approved snapshot and there was nothing behind it. `createPublish` refuses that case — covering the API and MCP callers too — and the dialog disables Publish with the reason. Where an approved version exists but the working copy is ahead, the dialog names which version readers get; in a stewardship-enabled nest, publishing a document that never went through review carries a warning.

  **Tags describe one document one way.** A document carrying `#GTM` and `#gtm` showed both on its card while the editor, which keys tags case-insensitively, showed a single `gtm`; the nest's tag facet keyed its counts by the raw stored tag, so the chip labelled 2 returned 3 documents because clicking it filters case-insensitively. The node response every surface reads now normalizes and dedupes, and both facets key by the normalized tag, counted once per document. A tag the engine cannot store — `café` reached `TAG_PATTERN` deep in the write — is now a 400 that names the tag rather than a generic server error with the document unsaved in the editor, and the editor folds the offending characters out inline before Save.

  **Workflow wire labels are readable.** A condition longer than the ~90px gap between two cards was cut at a fixed 34 characters with no ellipsis and centred on the wire, so it ran off both ends and under the cards, which paint after the wires. Labels are now their own pass drawn after the cards, sit in the empty row gap just above the cards' top edge on a background plate, ellipsize at 46 characters, carry the full rule on hover, and still select the wire on click.

  **Bulk approve collects a comment.** Approving from the review queue confirmed with no way to say anything while approving the same document from its own page collected one, and the My Work inbox ran the same `bulkReview` call through a confirm-only dialog — so an identical batch approved with or without a note depending on where it came from. The server already accepted a shared note for the batch.

  **Imports and names.** A second import of the same folder skipped the duplicate-slug guard `createNest` and `renameNest` run and surfaced `UNIQUE(user_id, slug)` as a 500; all three share one `assertSlugFree` helper now. Reserved vault filenames (`context.md`, `Readme.md`, `Index.MD`) match case-insensitively, since on a case-insensitive filesystem those are the same file. A nest name holding a run of whitespace rendered shorter than it was stored, so the name copied off the delete dialog never equalled it and Delete stayed disabled — both sides are compared with whitespace collapsed. Tag-shaped text in a nest name is refused with a message instead of being stripped, which had silently eaten "Roadmap <2026> plan" down to "Roadmap plan".

  **Smaller things.** The hosted artifact preview URL named its `nodes/` segment twice and now emits it once, resolving either spelling so existing links keep working; resolving a hosted node id reads the nest's layout instead of a probe read that always failed on a structured nest. Creating an empty folder toasts on success, the way it already did on failure. The Collaborators tab's stewardship requirement is its own labelled line rather than an aside, and points at the Stewards tab.

## 1.20.0

### Minor Changes

- 1d65b12: Agent SSO: exchange an IdP ID token for a short-lived MCP bearer.

  `POST /auth/token-exchange` (RFC 8693-shaped) lets an external agent, acting for a user your IdP (Microsoft Entra / Google) has already authenticated, trade that IdP's ID token for a scoped MCP bearer — no second login, no static API key. **Off by default**, and it stays off until a superadmin enables it in Settings → Single sign-on → Agent SSO (or sets the env vars).

  Because the endpoint trusts a token minted elsewhere and hands back access, the verification is the feature. The inbound `subject_token` is checked for signature (the provider's JWKS, `RS256` pinned), issuer (exact per provider — the tenant-scoped Entra issuer or Google's), audience (your configured client id, so a token minted for another application cannot be replayed here), and expiry, then the same `email_verified` + domain-allowlist policy as browser login before the user is resolved or JIT-provisioned.

  Provisioning **fails closed**: auto-provision with an empty `OIDC_ALLOWED_DOMAINS` is refused at mint time (`no_account`) and refused at save time by `/admin/settings`, because that combination would otherwise let anyone with an account at a public IdP sign themselves up and walk away with a bearer.

  Minted bearers are signed with a dedicated `MCP_SIGNING_SECRET`, distinct from the PromptOwl shared secret, so self-hosted deployments can issue their own; the `/index` and `/mcp` acceptor verifies a ticket signed with either secret via independent constant-time checks. Clearing that secret revokes every outstanding bearer — turning the master flag off only stops minting.

  Unlike the browser flow there is no session to bind, so the OIDC `nonce` binding is deliberately dropped; trust rests on signature + issuer + audience + expiry + `email_verified`. `scope: "mcp"` is a route allowlist, not a reduced permission set — the bearer carries the user's full stewardship rights, so keep `MCP_TOKEN_TTL_SECONDS` short. Both tradeoffs are written up in `CONFIGURATION.md → Agent SSO (token exchange)`.

  Alongside it: the OIDC discovery cache holds one entry per issuer instead of one entry total, so OIDC login and the two token-exchange providers no longer evict each other and refetch JWKS on every alternating request.

- 6f0be95: Public Docs Reader Mode, and an acknowledgement before a nest goes public.

  **Reader Mode** is a superadmin switch (`PATCH /nests/:id/reader-mode`) that changes how a nest reads for people who can only read it. With it on, a viewer gets a clean three-pane docs reader — navigation, the document, and a persistent home pane — instead of the authoring shell, and the board, ontology graph and definitions tabs disappear. Owners, editors, reviewers and admins are unaffected and keep the full tabbed UI, so the same nest is a docs site to its readers and a workspace to its stewards. An optional home node names the landing document; unset, it resolves by convention.

  Reader Mode is presentation only. It hides authoring surfaces from people who already could not use them — it grants nothing and gates nothing, and access control is unchanged.

  **Making a nest public now takes an explicit acknowledgement.** `PATCH /nests/:id/visibility` with `visibility: "public"` returns `409 requires_acknowledgement` unless the request also carries `acknowledge_public: true`; the UI asks first, in the same words the server answers with — the nest becomes readable by anyone on the internet, outside your organization. Going back to private is unguarded.

  **Breaking, for API callers:** an existing integration that flips a nest to public with `{ "visibility": "public" }` alone now gets a `409` and no change. Add `"acknowledge_public": true` to that request. Reads, private-visibility calls, and every other nest endpoint are untouched.

- 17627f5: Publish: host one document as a standalone page at a gated `/p/<slug>` link.

  A **Publish** action on any document (owner/admin, from the document menu or the editor) mints a stable, unguessable link that serves that document full-screen to people with no account. Distinct from nest visibility, which opens a whole nest, and from grants, which share with an authenticated user: a publish exposes exactly one node and no other, and the public surface is mounted outside the `/nests` auth chain so no node API is reachable from it.

  Four gates. **Public** serves immediately. **Passcode** takes one shared code — bcrypt-hashed, because a human-chosen secret gets the password treatment rather than the fast hash reserved for high-entropy tokens — with a show/hide toggle on the field, since a code read off a slide is easy to mistype. **Email** and **invite** mail a one-time link; invite additionally holds an allow-list. Both issue an `HttpOnly` session cookie scoped to `Path=/p/<slug>`, so clearing one link's gate never opens another.

  **Only the approved version is ever served.** The page reads through the same snapshot reader the hosted artifact viewer uses, so an in-progress edit does not reach the open web the moment it is saved, and a document that has never been approved 404s rather than exposing its draft. That is the point of publishing from a governance product rather than a file host.

  Per-link overlays: **expiry** and **revoke** (both enforced on every route, so revoking kills live sessions, not just new ones), **watermark**, which stamps the viewer's email across the page, and **no-download**, which blocks copy, cut, right-click, drag, printing and the save/print/copy/view-source shortcuts. Those last two are deterrents and are labelled as such in the UI: the document has already been delivered to the reader's machine, so screenshots, developer tools and `curl` still return it. Watermarking is a no-op on the public and passcode gates, which identify nobody — attribution is the lever that actually deters, which is why it needs an identified viewer.

  **Comments**, per link. A reader opens a modal on the page itself and posts without navigating away; the comment lands as an unanchored annotation thread on the document, in the same list stewards already read, and never renders on the published page. Every comment carries an identifying email — the gated viewer's where one exists, otherwise one they supply, which is self-asserted on public and passcode links. Because the document runs under the artifact sandbox, which blocks forms and network calls and propagates those restrictions to any popup it opens, the comment UI cannot live inside it: the page frames the document in a same-origin iframe and keeps the controls on the outer shell, leaving the document's sandbox intact.

  Markdown documents are rendered server-side, so a published note reads like the editor instead of showing its own `##` and `**` source.

  On the security posture: slugs are 64 bits of randomness behind a unique index; magic-link tokens are single-use, stored hashed, and re-checked against the allow-list when redeemed rather than only when sent; the gate answers an invited and an uninvited address with the same page _and_ the same database work, so it cannot be timed into an allow-list oracle; the gate is rate limited per link per IP; and a revoked, expired or unknown slug all produce one identical notice, which never confirms that a given slug was real.

  Email and invite links are refused on a server with no mail transport configured, and the dialog disables those two gates, because their only way in is a link that could never be sent. **Set `PUBLIC_BASE_URL` on any deployment using them** — unset, the mailed link is built from the request's `Host`, so a proxy forwarding an attacker-supplied host would send the recipient a one-time access token pointing somewhere else.

  Every served view is logged with the viewer's email where the gate identifies one, visible to the owner in the dialog's "who viewed" panel.

- Bulk approve/reject, in the review queue and in the cross-nest inbox.

  Clearing a folder import meant opening, deciding and going back once per document — which is what keeps queues from being cleared. `POST /nests/:id/review-queue/bulk` takes up to 50 node ids and runs each one through the same approve/reject the single-document routes use: same permission resolution, same state validation, same history and notifications, no override path. It reports per item, so a refusal on one leaves the rest applied.

  Both surfaces get the selection. The in-nest review queue grows a checkbox per reviewable row, a select-all bar, and a confirmation that demands a reason for a rejection exactly as the single flow does. The cross-nest inbox — where a reviewer actually meets a batch — gets the same, with deletion rows left out since they carry their own two-way decision. An inbox selection can span nests while the endpoint is per-nest, so it is grouped by nest and each nest gets one call; different vaults, so those run together, while items inside a nest stay sequential. Whatever failed stays selected for a retry.

  **The batch path is a steward action, not a write.** The nest middleware bumps every non-GET to `write` unless the path is on the steward-action allow-list — approve, reject, submit-review and cancel-review are on it precisely because a reviewer normally holds `read` collaborator access plus a reviewer steward row. The new path was not, so single-row approve worked while the batch answered `your permission: 'read'`. It joins that list and grants nothing extra.

  Selection state is pruned rather than trusted: it is dropped as the inbox reloads (a page turn or a row that resolved on its own otherwise left the bar counting rows the batch would find nothing to act on, then reporting "0 approved" as success), and reset when the nest changes, since the nest view is reused rather than remounted and could have carried one nest's ids into another nest's batch. The 50-item cap is enforced where the selection is made as well as on the server, and batch ids pass through the same node-id containment guard every other id-taking route uses.

### Patch Changes

- App shell: an honest boot, an honest empty nest, and a dead link that explains itself.

  **The boot screen is branded.** A full reload showed a bare "Connecting…" on an empty page, which reads as a connection fault rather than a normal boot; it now shows the nest logo, the product name, and a loading line. Opening a document also flashed "Untitled" in the header and title while the fetch was in flight — that placeholder is a fact about a saved document, so it only appears once loading has finished.

  **An unresolvable `?nest` link explains itself.** A deleted nest, a mistyped id, or access that was revoked all landed silently on the Dashboard, so a stale bookmark looked like it had simply opened the app. The deep-link probe now separates "no nest requested" from "the requested nest didn't resolve"; the second renders an explicit message with a retry and a way back to the Dashboard, which clears the dead parameter from the URL. An unauthenticated visitor still sees Login, unchanged.

  **An empty nest reads as empty, not as governed.** With zero documents the Overview still subtitled Total Documents "Auto-approved, AI-ready" and the AI Ready card "Approved for AI", implying governed content that does not exist; both now read neutrally. The graph's coverage panel showed the amber warning icon beside "No documents yet" for the same reason — it is informational while the graph is empty, and the warning stays for real gaps such as unstewarded categories and orphans.

  **Stewardship guidance follows the setting.** Share and Collaborators told people to assign stewards, but the Stewards tab only exists once Stewardship & Approval Workflow is enabled — and new nests default it off, so the guidance sent readers looking for a surface that isn't rendered. Both now name the setting that unlocks stewards when the workflow is off, and point at the Stewards tab when it is on.

  **New Nest opens as a modal**, like Import Folder, so Escape, the backdrop and Cancel behave identically across two actions that do the same kind of thing. The create handler and its validation are untouched.

  **Keyboard shortcuts are documented.** `?` was inert and the account menu had no reference. A shortcuts dialog lists the global, search-palette and editor bindings, opened with `?` or from the account menu; the handler ignores the key while an input, textarea or the editor has focus, and the modifier label follows the platform.

- bbbeb18: Six Community bug fixes across stewards, tables, annotations and definitions.

  **Assign Steward no longer opens on an unsubmittable form.** In a nest with no tags the dialog defaulted to the tag scope, whose picker had nothing to offer — the only way through was to discover the scope selector. It now falls back to the nest-wide scope once the tag list comes back empty, and the tag scope is unselectable while there are no tags.

  **Commenting on an artifact is no longer authoring a document.** The annotation projection an artifact comment mints counted as a first-class document everywhere: documents list, board, graph, search, tag facets and the nest's total. It is still a real node — that is how an agent reads the feedback back on the next iteration — but every user-facing surface now leaves it out. MCP still sees it.

  **Replacing a definition keeps its linked tag.** Re-defining an existing term from the add form also cleared the tag it already carried, because an empty tag box was sent as an explicit "remove". Blank now means "not specified" when replacing, and still means "remove" when editing a row whose tag field was prefilled.

  **Typed table columns are checked.** The CSV preview rendered duplicate `:key` values and non-numeric `:number` cells as ordinary rows, so a typed header looked enforced when nothing checked it. The preview now says what disagrees with the header. Advisory rather than a save gate: a human-maintained fact store with one bad cell is still worth saving, and blocking would break saving already-imported tables.

  **Version compare renders a table as a table.** In Rendered mode a table document's CSV went through the markdown renderer and collapsed into a single run-on paragraph with no sign of what changed. Each version now renders as the grid the reader sees, with the rows the other version lacks tinted.

  **The documents type filter reads in title case.** The newer table and tool types had no display label and fell through to the raw type name, in both the dropdown and the active filter chip.

- 666585d: Eight Community improvements across the markdown renderer, the inbox, reviews, the graph, search, sharing and folders.

  **Math and footnotes render.** `$…$` and `$$…$$` are typeset with KaTeX, and inline math that starts or ends with whitespace is left as text so prose like "costs $5 and $10" is unaffected. Footnotes already parsed, but the editor escaped the reference bracket on save, storing `[^1]` as `\[^1\]` — that escape is now undone alongside the wikilink one.

  **Notifications can be cleared one at a time.** The inbox only offered "Mark all read"; each row now carries its own mark-as-read control.

  **A pending submission can be withdrawn.** Review rows under "Waiting on others" offer Withdraw, cancelling the review and returning the document to Draft — previously the only exit was Delete. The endpoint existed but was unreachable and unauthorized; it now admits the submitter, and otherwise requires approve rights.

  **The graph navigates.** Coverage-gaps orphan entries open their document, the selected-node panel gains an Open document action, and double-clicking a document node opens it. Single click still selects the node, so the neighborhood highlight and copyable query are unchanged.

  **An empty nest no longer looks fully governed.** With no documents, Coverage gaps showed "Every category has a steward" and "No orphans" — vacuously true. It now says there is nothing to evaluate yet.

  **Search says what it is searching.** The ⌘K palette searched one nest or every nest depending on where it was opened, with nothing indicating which. It now names its scope and, inside a nest, offers This nest / All nests.

  **Nest access is one surface.** The Collaborators tab and the Share dialog duplicated each other, with the tab sending users to the dialog for visibility. Visibility moves into a control both render, the tab now covers visibility, people and teams, and the nest's Share button opens that tab.

  **New folders start empty.** Creating a folder seeded a real "Overview" document that then counted as content everywhere, including the AI-eligible set of an auto-approved nest. A folder is a directory in the vault, so creating one now creates that directory with only the generated INDEX.md in it; folder listings merge the vault's directory shape with the index's counts, and deleting a folder removes its directory.

- Documents, viewer and team sharing.

  **A filtered document list shows only the folders that matched.** A filter matching a single document still rendered every folder in the nest above it, one indented row per level. The tree is seeded with all known folders so a folder whose documents were never fetched still has a row to expand — but a filtered list is answered from the whole nest, so that seeding only added folders holding no match and suppressed the component's own chain compaction. The seed is dropped while a filter is on, leaving the folders that actually matched, each deep chain reading as one `Content / Drafts / Blog` row. Unfiltered browsing keeps its lazy expansion unchanged.

  **Wiki links render as «Title».** They were distinguishable only by link colour; the display text is now wrapped in guillemets, matching Hootie's renderer, so a wiki link is recognisable at a glance and in a screenshot. The click target and hover preview still use the bare title.

  **Sharing a team notifies its members in the app.** A direct collaborator invite already dropped a `nest_invite` row in the invitee's inbox, but sharing a team onto a nest only sent email — members had no in-app signal. The team-share fan-out now writes the same inbox row per member, naming the team the access came through and the role in collaborator terms (Viewer/Editor/Admin), never the raw permission. The person doing the sharing is skipped, as on the direct path.

- Editor: the preview shows what the reader sees, and markdown survives the round trip.

  **Preview renders the reader view.** The preview toggle only locked the editor and collapsed the toolbar, so the body stayed in TipTap's own editing model — anything TipTap has no node for (math, footnotes) showed as raw source and the preview misrepresented the document. It now renders the current markdown through the same reader the view and comment modes use. The editor stays mounted behind it, so toggling back keeps caret position and undo history.

  **The preview toggle is labelled.** It was an unlabelled eye icon, so math and footnotes — which stay raw source in the editor — looked unsupported to anyone who never found it. The control now reads "Preview", and its counterpart in preview mode reads "Edit"; the rest of the toolbar strip stays icon-only.

  **LaTeX commands survive the serializer.** `prosemirror-markdown` escapes backslashes and underscores in every text node, so a saved `$\frac{1}{2}$` reached KaTeX as `\` + `frac` — a line break followed by a bare word, rendering "frac12". Markdown specials inside math spans are now unescaped on the way out of the editor, alongside the existing wiki-link and footnote unescapes, so fractions, roots, integrals, sums and Greek letters render. Documents saved before this land correctly on their next save.

  **Every heading level round-trips.** The editor schema capped headings at H3, so `#### Heading Four` stayed literal text when typed, and was silently flattened when a document written elsewhere was opened. The schema accepts H1–H6, and the toolbar renders one button per accepted level — driven by the same level list the editor is configured with, so the two cannot drift.

  **The markdown-source toggle sits on the Content label.** Switching between the rich editor and raw markdown is something you do while writing, so it sat oddly in the header's overflow menu among document actions (version history, sharing, delete) and took two clicks to reach. It is now a small labelled button naming the mode you switch to, and is gone from the overflow menu. Tool and table nodes, which have no rich editor, still show no toggle.

- Folder import and nest names.

  **Derived vault files stay out of the document list.** `INDEX.md`, `CONTEXT.md`, the agent configs and `README.md` are regenerated on every write, so an edit to one is thrown away by the next mutation — yet they listed as editable documents: the engine excludes `CONTEXT.md` at the vault root only, so a nested copy read as a real document, and `README.md` was excluded nowhere on imported nests. One shared `isMetaFile()` replaces the three drifting copies of that list, applied at the discovery cache — the chokepoint every listing, search, folder count, graph query, index rebuild and import registration reads through. The files still sync to disk verbatim; only their visibility changes.

  **One oversized file no longer kills an import.** The uploader splits between files, never inside one, so a file over the chunk budget shipped alone in a body the server answered `413` to — aborting the whole import and deleting the half-built nest. Such a file is now skipped and reported by name alongside the paths the server refused, and the rest of the folder lands.

  **Nest names are stored as plain text.** A name went to the database exactly as typed, so `<img src=x onerror=alert(1)>` was accepted with `201` and stored verbatim. The list renders it escaped, but any surface that does not — export, email — would inherit the markup. Tag-shaped markup is stripped in the one helper the create, rename and import paths share. Because stripping leaves an empty string, a name that is nothing but markup used to come back as "Name cannot be empty" — accurate about the stripped value, confusing about what to do; the refusal now names the real problem, in the client mirror that gates the submit button and on the server, which keeps refusing the same names for callers that skip the UI.

  **The submit-for-review dialog keeps its space.** JSX drops the whitespace of a line break following an expression, so the confirmation read "Version 1will move to pending review".

- Search: one entry point, grouped results, and a scope you can reach from the keyboard.

  **One control, everywhere.** The Dashboard carried its own field-styled "Search nests & documents" button while every other page used the header's Search control, so one feature read as two. The header control now shows wherever the palette works, the Dashboard duplicate is gone, and the tooltip names the scope for that page. It no longer hides on small screens either — only the ⌘K hint does.

  **Results are grouped.** Nest and document matches shared one undivided list, so telling them apart meant reading the small icon or the right-hand label. Results already arrive nests-first, so a header before each run labels them without reordering rows or disturbing the keyboard selection index.

  **The dead end offers the way out.** A scoped search that found nothing said only "No matches", which reads as "that document does not exist" even when it lives in another nest. The empty state now names the nest that was searched and carries a "Search all nests" action.

  **The scope is keyboard-reachable.** Switching between This nest and All nests needed the mouse, in a palette that is otherwise keyboard-first. Tab flips the scope from the query field — there is one input, so nothing else was worth tabbing to — the scope row shows the key, the tabs take a visible focus ring when focused directly, and Escape closes the palette from anywhere in it rather than only from the input. Shift+Tab stays inside the palette instead of escaping to the page behind it.

- Tags: the field stops promising what the store will not keep.

  **Each tag is capped at the real limit.** The Tags field accepted 120 characters while a tag is truncated to 40 on commit, so users typed characters that were silently discarded. The cap applies per whitespace/comma-separated token rather than to the whole field, which keeps a multi-tag paste (`api, v2, docs`) intact while stopping any single tag from growing past what will be stored.

  **`#bug` and `bug` collapse.** Duplicate detection compared a normalized candidate against the raw stored value, so a legacy `#bug` and a newly typed `bug` coexisted on one document with inconsistent chips. Both sides now key through the same normalizer, and the editor canonicalises a document's tags on load — chips read consistently and the next save migrates the legacy values.

  **A paste that normalizes several tags says so once.** Committing a pasted multi-tag value fired one transient toast per rewrite, so the feedback scrolled past before it could be read. The batch is summarized in a single longer-lived toast naming every affected value; a lone rewrite still reads as its own message.

## 1.19.0

### Minor Changes

- bb7a11e: Cite source node URLs in `POST /nests/:id/context`.

  The one endpoint that grounds both "Chat with the nest" and "Set up agent" now carries each node's source URL, so answers can cite inline and consumers can render clickable citations. Two additive changes to the response shape: every `nodes[]` entry gains a `url` deep link (`<base>/?nest=<nestId>&doc=nodes/<slug>`), and every context block gains a `_source: <url>_` line alongside the existing `_tags:` line. The `_source:` line is built before the token estimate, so it counts against `max_tokens` rather than silently overflowing the budget.

  URLs are built in one place — `resolveNodeUrl(node, { nestId, baseUrl })` in `src/governance/title-resolver.ts`, wrapping the existing `docLink()`. That is the seam the public `/p/:slug` URL will swap into once the publish/hosting work lands, rather than every call site.

  The base is `PUBLIC_BASE_URL` when set, falling back to the request origin. When neither resolves, `resolveNodeUrl` returns `undefined`, so `url` is omitted from the payload and the `_source:` line is left out — no empty `href=""` reaches a consumer. **Set `PUBLIC_BASE_URL` on any deployment whose citations reach users**: without it the cited origin comes from the incoming `Host` header, which a proxy that forwards an untrusted value would let an attacker influence.

- Curated tag columns on the board, and a pass over the edges the UI kept getting wrong.

  **The tag board is user-curated.** It starts empty and shows only the columns you add — no tag auto-appearing as a column the moment one document carries it, and no Uncategorized catch-all collecting everything else (`ui/src/lib/board-dimensions.ts`, `ui/src/components/MaturityBoard.tsx`). Folder and status boards are unchanged and still auto-populate. Dragging a card between tag columns now retags the document: the source column's tag comes off, the target's goes on, in one `updateNode` write. The old "tag columns are read-only" limitation was written against a PATCH that unioned tags; PATCH replaces the tag set, so a swap has been expressible for a while.

  Tag column keys are the bare value, but tags are stored with a leading `#`. Every crossing of that line goes through one strip/add pair, and a layout saved under the old `#`-prefixed spelling is migrated on read (`migrateLayout`) — a curated board repairs itself instead of rendering a row of columns that match nothing.

  **An unknown node type is a 400, not a 500.** `POST /nests/:id/nodes` with a type the server does not know slipped past the create choke point and threw an opaque "Something went wrong" from deeper in the write path, telling the caller nothing about which field was wrong. An allow-list guard at the same point that already gates the disabled types now rejects it with a `ValidationError` naming the accepted types (`src/nodes/service.ts`).

  **`context_list` no longer 500s on the storage-side filter key.** `listNodesForCaller` built one filter object for two consumers that spell "include retired" differently — `includeRetired` for the engine's `filterDocuments`, `include_retired` for the `context_list` operation. The camelCase key rode along into the operation call, harmless while the engine stripped unrecognized parameters and a hard error now that it rejects them. Every listing that crawls for bodies was returning a 500, taking `/runnables`, `/changes`, the node index, annotations and `context_overview` with it (`src/nodes/query-routes.ts`).

  ### Documents

  - **Tags are case-insensitive.** `Bug`, `bug`, `TAG` and `tag` produced four chips for two tags; input is lowercased on entry, and de-duplication is case-insensitive so documents saved before this change behave too (`ui/src/lib/tag-policy.ts`).
  - **The tag field previews what it will add** while you type, with the rewrite note, instead of truncating and normalizing on commit and explaining it in a toast afterwards. It carries a `maxLength` the way Title does. Preview and commit read the same `newTags` function, so the line cannot promise a tag the commit will discard as a duplicate.
  - **The Compare picker shows version dates** — relative time beside the author, absolute on hover — so picking a past version isn't guesswork (`ui/src/components/DocumentEditor.tsx`).
  - **Backing out of a document lands on the Documents tab**, not the nest's Overview.
  - **New folder… is separated from the folder destinations** in the Move dropdown, rather than reading as one more destination.

  ### Dashboard

  - **The filter applies to unsynced folders.** They were rendered off the raw list and ignored it entirely: selecting "Public" showed one matching nest beside every unsynced folder on disk, with a result count that contradicted the grid. An unsynced folder is a directory, not a nest — no owner, no collaborators, no visibility — so every access scope hides it and the text query matches its label or path. Two sync-state scopes are added, offered only when a folder is actually waiting to sync (`ui/src/lib/dashboard-scope.ts`).
  - **Clear filters is available while the grid still has results**, not just from the empty state, and it now resets the sort order along with the scope and query.

  ### Runs

  - **Run rows fit their card at any nesting depth.** Cancel and Spawn sub-agent collapse into the shared overflow menu, the depth badge and child count move off the title line, the indent stops compounding, and the row clips rather than overflowing.
  - **The run list marks a truncated ID** with an ellipsis and the full value on hover — the same run appeared to carry two different IDs between the list and the detail view.
  - **An overflow-menu action can animate its icon** again, so a cancel in flight spins instead of looking hung.
  - **The tool source editor highlights its code** in a preview pane beside the textarea, reusing the lowlight component the read view already had. The preview reads a deferred copy of the body, so auto-detection runs on a spare frame rather than on the typing path.
  - **Table CSV source and preview sit side by side** on large screens instead of stacked.

- 3fc9c76: Pick up the engine's per-vault write lock, and retire the last legacy write path.

  Engine 2.4.0 ships a cross-process write lock (PromptOwl/ContextNest#78): every mutation through the operation catalog serializes on it, and a writer that cannot acquire it within 20s fails with `VaultLockTimeoutError`. The engine pin moves to `^2.4.0` to take it. Two things had to be true here before that upgrade was safe:

  **Every wire surface now maps the lock timeout to a retryable error.** REST returns `503` with a `Retry-After` header (via a new `VaultBusyError`); MCP returns an `isError` tool result whose `structuredContent` carries `code: "VAULT_BUSY"` — never a generic 500. Detection matches the error by `name`/`code` rather than `instanceof`, so it survives the package boundary — and, because it keys on the error rather than the class, it was already correct against the engine versions that predate the lock.

  **`POST /nests/:nestId/publish` no longer writes documents by hand.** It was the last pre-catalog write path — hand-built frontmatter, its own slugify, direct `writeDocument` — invisible to any engine-side locking. It now routes each document through the same `createNode` path as every other create surface. One behavior change: a document whose title slugs to an **existing id is skipped and reported** in a new additive `skipped` response field, instead of silently overwriting the existing document and restarting its version history.

  Going through `createNode` also means a single document can now be refused on its own merits — an unusable title, a type the engine does not know. The batch is not a transaction, so a row that fails is reported in a new additive `failed` field and the remaining documents still publish, rather than aborting the batch and leaving the earlier writes on disk with nothing in the response naming them. The one error that still stops the batch is the lock timeout itself: it answers `503`, and retrying is safe because everything the first attempt created comes back under `skipped`.

  One gap stays open on purpose: the `context_md` half of that same endpoint has no operation in the catalog to route through, so it remains a direct write and will not be covered by the lock. It cannot answer a retryable `503` either — there is no timeout to map. Closing that needs an engine-side op for `CONTEXT.md`, which is Phase B work.

  Also removed the dead `safePublishDocument` wrapper, and added the concurrent-writes regression for the MCP surface (the REST surface already had one): a burst of concurrent `context_update` calls must land as a contiguous, duplicate-free, fully reconstructable version history with nothing staged by a drift scan.

## 1.18.0

### Minor Changes

- Connect gives you a working setup, not a wall of client tabs.

  Connecting an agent meant picking among five client tabs, copying a JSON block, and guessing which fields your key went in. The new flow leads with a one-shot setup prompt you paste into the assistant itself, plus a downloadable `.env`, and pushes the per-client configs and the export/portability/nest-id details behind an advanced toggle (`ui/src/components/ConnectModal.tsx`, `ui/src/lib/connect.ts`).

  The prompts are aware of the server they were generated from: open-mode instances don't advertise a key, the described write scope matches what the credential actually permits, and the CLI snippet uses the flag the current `ctx` release takes. An all-nests landing surface (`ui/src/components/AllNestsBar.tsx`) carries the same quick-start inline, so the first connection doesn't require opening a nest first.

- Finding and moving documents without leaving the page you're on.

  - **The nest grid filters, sorts, and pages** (`ui/src/components/Dashboard.tsx`). Past a couple of dozen nests the dashboard was a scroll, and a truncated name told you nothing — the full name and description now surface on hover.
  - **Move a document to another folder from inside it** (`ui/src/components/DocumentEditor.tsx`), and the Move dialog can create the destination folder it needs instead of sending you off to make it first. Folder paths are validated and previewed before creation.
  - **Folder trees show levels that hold only folders** — a branch whose documents all live one level down used to render as empty.
  - **The board can add folder columns** (`ui/src/components/MaturityBoard.tsx`), and run details open beside the selected run rather than at the bottom of the list.

- Large nests open from a DB node index instead of a vault walk.

  Opening a nest used to read every document off disk to answer questions the listing only needed metadata for — title, folder, tags, status. On a nest with a few thousand documents that meant a full crawl per request, and the page either crawled or timed out.

  Now each nest keeps a `node_index` table (`src/nodes/node-index.ts`) holding one row per document, kept current on write, move, and delete, with `nests.index_synced_at` recording the last full sync. Listings, folder trees, and cross-nest search read the index; the vault is only touched when a caller actually wants a body. Folder deletes clean their index rows, moves regenerate them, and the drift scanner no longer marks every nest stale on a cold start.

  The Postgres schema gets `nests.index_synced_at` through an explicit `ALTER` rather than a table rebuild, so an existing deployment migrates in place.

- Several API keys per account, so a client can be rotated without cutting off the rest.

  One key per account meant one credential shared by every editor, agent, and CI job — and rotating it because a laptop went missing revoked all of them at once.

  An account can now hold multiple named keys (`src/auth/keys.ts`, `ui/src/components/ApiKeysPage.tsx`). Each name must be unique within the account so a key is identifiable after the secret is hidden, and rotate is a true replacement: it issues the new secret and retires the old one in a single transaction, so two concurrent rotations can't leave the account with two live keys or none.

### Patch Changes

- v1.18.0 — nests that open at size, one credential per client, and a long sweep through the editor and review surfaces.

  ### Governance and review

  - The review modal shows the document body again, and Approve/Reject are back for reviewers who have the authority to use them.
  - A reviewer's rejection reason appears in version history, and rejected external edits are recorded there instead of vanishing.
  - Compare diffs against the selected version's real body, not a stale copy.
  - Sharing refuses a grant to someone who already reaches the target by another path, and says so when a document is already shared with that person.
  - Steward pickers for documents and tags are searchable, scroll inside their dialog, and stay pinned to the field width.
  - Invite and connector emails use the user-facing role names rather than raw permission strings.

  ### Editor

  - Unsaved state is visible, and a save that would do nothing is no longer offered.
  - Document tags have a length and character policy.
  - A missing document renders a not-found state instead of a blank editable page.
  - International document titles are supported.
  - Table and artifact drafts get live previews, with the tool source highlighted.
  - Toasts and dialogs stay inside the window, and the viewport clamp no longer stretches every dialog to full width.

  ### Workflows and definitions

  - The workflows view restores from a cold deep link.
  - Unclaimed runs show as queued and can be cancelled.
  - Defining a term warns before it overwrites an existing one.
  - The definitions endpoint sits behind a developer disclosure.

  ### Performance

  - Cross-nest search no longer pays for a cold crawl.
  - A nest summary is read once per nest rather than once per folder.

## 1.17.0

### Minor Changes

- f2a1a78: Deletion requests are editor-only — viewers no longer see the action at all.

  Flagging something for deletion used to be read-tier, on the reasoning that whoever notices dead content usually can't delete it. In practice that handed the action to everyone who could merely _see_ a document — read-only collaborators, viewer stewards, and now anyone holding a read share grant — and produced requests from people with no stake in the content. Someone who cannot change a document has no standing to propose destroying it.

  Now: `POST /nests/:id/nodes/:nodeId/request-deletion` and `POST /nests/:id/request-deletion` require **editor** authority, meaning any of the three paths that already let someone change the target — nest-wide `write`, an editor steward row covering it, or a `write` share grant on it. A folder or nest flag additionally wants a **nest**-scope steward row: a row scoped to one document is no mandate over everything around it. Below that the answer is `403`, after the existing read check, so the gate never doubles as an existence oracle. Deleting outright is unchanged (owner/admin, or the document's author).

  The rule lives in one predicate (`canRequestDeletion`) shared by the REST routes and the `context_request_deletion` MCP tool, so the agent surface can't become the way around it.

  In the UI the action is withheld rather than offered and refused: no Delete entry on a document's ⋯ menu or list row for a viewer, no request affordance on a folder row, and no nest-level Delete for viewers or reviewer-only stewards.

- v1.17.0 — narrower sharing, a review queue that reads the same everywhere, and an editor that stops inventing versions.

  ### Governance

  - **Withdraw your own pending deletion request** — a requester can retract a flag they raised without waiting for a reviewer to reject it. The withdraw path sits at read tier deliberately: the person who filed it can always unfile it, even after the editor-only gate on _raising_ one (`src/governance/review-service.ts`, `src/governance/routes.ts`, `ui/src/components/DocumentEditor.tsx`).
  - **My Work reject requires feedback**, and both approve and reject now route through the shared `ReviewActions` component, so the dashboard and the document surfaces stop disagreeing about what rejecting means (`ui/src/components/Dashboard.tsx`, `ui/src/components/governance/ReviewActions.tsx`).
  - **One word for the negative action** — "Reject", replacing the three different names the same button carried across review surfaces (`ui/src/components/governance/ReviewActions.tsx`).
  - Reviewers opening a pending-review document land with comment mode already on, and authoring controls are withheld from viewers and reviewers rather than shown and refused.

  ### Search

  - **Viewer-accessible nests are covered by global search.** A nest reachable only through a viewer role was silently absent from cross-nest results — the search path resolved access differently from every other read (`src/nodes/search.ts`, `src/nests/service.ts`, `src/governance/access-guard.ts`, `src/app.ts`).
  - **Quick-open shows the matching snippet**, not just the title, so a hit in the body is legible without opening the document (`src/nodes/search.ts`, `ui/src/components/QuickOpen.tsx`).

  ### Editor

  - **A no-op Save no longer creates a version.** Pressing Save without edits used to mint a new document version; it now short-circuits and toasts instead (`ui/src/components/DocumentEditor.tsx`).
  - **Agent Schedule is validated per cron field position** and echoed back as a human-readable interpretation, instead of accepting anything and failing later (`ui/src/lib/schedule-validation.ts`, `ui/src/components/DocumentEditor.tsx`).
  - **Text color persists to markdown** and renders in both the viewer and the editor — it was previously an editor-only preview that was dropped on save (`ui/src/components/DocumentViewer.tsx`, `ui/src/components/MarkdownEditor/MarkdownEditor.tsx`).
  - The ``` code-fence shortcut fires on a blank line (`ui/src/components/MarkdownEditor/extensions/CodeBlock.ts`); the wiki-link popup has an empty state; New Document focuses Title and warns on Type reinterpretation.

  ### Performance

  - **The discovery cache stays warm across nest writes** instead of being dropped on every publish (`src/nodes/engine.ts`, `src/mcp/tools.ts`, `test/discovery-cache.test.ts`).

  ### Fixes

  - Folder share targeted the wrong path and broke the dialog layout; a write grant is now honoured in the UI rather than rendered read-only.
  - Doc/folder grantees can read the nest's Definitions glossary; viewer-role collaborators can export the portability `.zip`.
  - Root is excluded from the Overview folder count; nest summary card titles clarified; publication is confirmed after a new document auto-publishes.
  - My Work no longer flashes its empty state during the initial load.

- 45e11a6: Share a single document or folder from the UI — the human half of the grants model.

  Grants (share one document, or everything under one folder, with one person) already existed on the server and in MCP as `context_grant`, but the only way to use them was an API call. Sharing something narrower than a whole nest meant either handing over nest-wide collaborator access or writing a request by hand — the wrong thing was the easy thing.

  Added:

  - **Share this document** on a saved document's ⋯ menu, and a share icon on every folder row in the nest view. Both open one dialog: add someone by email, see who the target is already shared with, and revoke. Owner/admin only, matching the `/nests/:id/grants` routes. Sharing from the UI is **view-only** and has no role picker — the API and `context_grant` still accept `write`, and a grant made that way is labelled as editable in the roster, but nobody hands out edit rights by leaving a dropdown where it was.
  - **The recipient can now find it.** A grantee holds no nest-wide permission, so the nest was absent from their dashboard — being shared a document only worked if someone also sent the direct link. The nest is now listed for them as a viewer (`permission: "read"`, `roles: ["viewer"]`, `grant_only: true`), with the card scoped to their slice: `document_count` counts only the documents their grants cover, and the collaborator/steward roster comes back empty, so a one-document share never reveals the nest's size or its people. Grant-only nests stay out of the work inbox and `/stats` — those are governance surfaces over documents the grantee cannot read.
  - **Fixed: "Nest not found" when opening a shared nest.** Following the link failed even with a valid grant — the middleware admitted the caller, then `GET /nests/:id` rejected them for holding no nest-wide permission, and the nest page's review-queue read surfaced the same 404 as an error toast. The grant check now lives in the one permission helper every nest route shares, so the nest resolves once for all of them instead of being patched per handler, and the page skips the governance reads a grantee was never allowed to make (seven wasted 404 round-trips per load). Authority is unchanged: rename, delete, import and settings-write still demand `owner`/`admin`, the governance paths still refuse a grantee, and `resolveNestPermission` — what the per-node grant checks key off — still answers `none`.
  - `/llms.txt` now names `context_grant` and its arguments, so an agent reading the public manual can find the one-call path instead of inferring it.
  - `API.md` documents `GET/POST/DELETE /nests/:nestId/grants` — resolution rules, the bare-`nodes`-root rejection, and how grants behave on move/delete/export.

  Access is not stewardship: a grant lets someone reach exactly the granted document (or folder subtree) and nothing else in the nest, and confers no approval rights. Nothing was loosened — `resolveNestPermission` still returns `none` for a grantee, and every read past the card runs through the same grant checks as before.

### Patch Changes

- a0eaebc: Hide the definitions editor from viewers instead of refusing them after the click.

  The Definitions page rendered the full "Define term" form, plus per-row edit and delete buttons, to everyone who could open the nest — including read-only collaborators, public readers, and share grantees. Writes were already refused server-side (`POST`/`DELETE /nests/:id/definitions` are write-tier), so a viewer could fill in a term and a definition, press the button, and get a toast telling them it wasn't theirs to do. The page even documented that as the design.

  Viewers now get the glossary read-only: no form, no row actions, and an empty state that doesn't invite them to write one. The gate is derived from `deriveNestCaps` on the nest read every other nest screen already makes, and is deliberately `canManage || collabCanWrite` rather than the looser `canEditDocs` — the steward-editor bypass in the middleware covers `/nodes` routes only, so a nest-scope editor steward without a write collaborator row is refused here by the server too, and the UI now says so up front.

  No server change: the existing read-tier denial is unchanged and still covered by `test/definitions.test.ts`.

- 4be85f9: Resolve nest permissions in one query instead of six.

  Every node read, every MCP tool call and every dashboard card resolves the caller's permission, and `resolveNestPermission` did it a query at a time: the nest row, the caller's email, the collaborator row, the steward row, the shared teams, then one query **per team**. `isPublicReader` then asked the same questions over again for its own answer. Three of those round trips were the identical `SELECT email FROM users` — the license-admin check ran its own copy.

  Both now derive from `resolveNestAccess`, a single statement that left-joins the caller, their collaborator row, and existence probes for a steward row and a share grant onto the nest row. With the caller's email in hand, both admin checks (`isLicenseAdminEmail`, `isSuperAdmin`) are pure functions over it and cost nothing. Team membership can't be joined — it lives as JSON in `teams.members` — but `shared_teams` rides along on the same row, and the per-team loop became one `IN (…)` query, consulted only when the answer isn't already settled at admin/owner.

  Measured, collaborator on a private nest and steward on a public one:

  | call                                           | before | after |
  | ---------------------------------------------- | ------ | ----- |
  | `resolveNestPermission` (collaborator)         | 6      | 1     |
  | `resolveNestPermission` (steward, public nest) | 6      | 1     |
  | `isPublicReader` (steward, public nest)        | 5      | 1     |

  The middleware and the nest routes now read `hasGrant` off that same row rather than issuing their own lookup, so `hasAnyGrant` is gone; `effectiveAccess` returns the facts alongside the permission so the nest list and single-nest handlers stop re-resolving to answer "is this caller grant-only?".

  No policy change: resolution order, the highest-wins merge across collaborator/team/steward/public sources, the anon-commons rule and the `admin` short-circuit all behave exactly as before, and `resolveNestPermission` / `isPublicReader` keep their signatures for their ~40 call sites. A new `test/nest-access-resolution.test.ts` pins the merge per caller shape — owner, collaborator, steward, grantee, stranger, public reader, missing nest — and asserts both wrappers still agree with the fetch they now share.

- 5d5de0d: Remove the duplicated CLI/plugin surface — it now lives in the ContextNest repo.

  The `ctx` CLI and the agent plugins are consolidating upstream in [PromptOwl/ContextNest](https://github.com/PromptOwl/ContextNest) (`packages/cli`, `plugins/`, `.claude-plugin/`). The community server carried its own copy of that contract — install commands, a `ctx push` snippet, and a CLI section in the public agent manual — which is exactly the drift the Engine & CLI Sync Discipline in `CLAUDE.md` exists to prevent. Every published `ctx` invocation was a second place the CLI's flags and command surface had to stay correct.

  Removed:

  - The **CLI** tab in the nest Connect dialog (the `ctx push --server … --nest …` snippet and the `npm i -g @promptowl/contextnest-cli` install line).
  - The **CLI** client hint on the dashboard.
  - The `CLI (ctx)` row in the Guide's surfaces table, which pointed at the now-removed Connect tab.
  - The `## ctx CLI` section and the CLI package entry in the `/llms.txt` agent manual, plus the CLI scaffolding block in `README.md`.

  No server behavior changes. MCP and the REST API — the community server's own surface — are untouched, and remain the documented way for an agent to read and write a nest remotely. Anyone wanting the CLI installs it from upstream, where its documentation is now the single source of truth.

## 1.16.1

### Patch Changes

- Drop four MCP catalog divergences that engine 2.1.0 resolved upstream.

  The catalog-conformance guard is exact in both directions: an undocumented mismatch fails, and so does a documented one that stops happening. Engine 2.1.0 tripped the second half. `context_create` and `context_update` now have `status` and `checkpoint` in the catalog output, `context_delete` declares the echoed `title`, and `NODE_TYPES` covers `table` and `agent` — all four were recorded here as divergences with a note that upstream needed to decide. It did.

  The entries are gone. The remaining divergences are untouched: `external_edit_pending` is still outside the engine's status enum, and `context_versions` still has no keyframe/content-hash/chain-hash model to report. The `table` and `agent` fixture nodes stay seeded so the widened type enum keeps being exercised rather than assumed.

## 1.16.0

### Minor Changes

- 10fc217: Hand folder import to the engine, and upload it in batches instead of a stream.

  Importing a folder failed with a bare "Import failed" and no reason, and spent a long time apparently doing nothing before it started. Three separate causes.

  **The failures had nowhere to surface.** Import streamed NDJSON progress over `POST /nests/import?stream=1`, which commits HTTP 200 _before_ any of the work runs. Every real failure therefore arrived as a successful response carrying an error line the client often never reached, and a buffering proxy would swallow the progress lines the stream existed to deliver in the first place. The streaming endpoint is gone. The upload now goes up in ~4MB chunks as ordinary JSON requests, each with a real status code and a real message — which also keeps a large folder under the request-size limits a single body was hitting. `registerImportedDocuments` used to `return 0` when the vault scan failed, which reported a broken vault as a successful import of an empty folder; it now throws.

  **The server did the engine's job, twice.** Import scanned the vault itself, then rewrote every document to stamp the importing user as `author`, and only then asked the engine to publish — which rewrites each document again. On a Cloud Storage mount that is two extra network round trips per document before publishing has even started. The engine's `context_import` now owns the whole flow: the community server writes nothing to the vault, it hands files to the engine (`files[]`), stages each chunk without publishing, and makes one `discover` call at the end that scans, stamps, publishes under a single checkpoint and returns the per-document detail needed for governance rows.

  **The browser read files one at a time.** Scanning a picked folder awaited each `file.text()` in sequence, which is the delay users saw _before_ an import appeared to begin. Reads are now batched, and sibling directories are walked in parallel.

  **Importing a folder no longer publishes documents that never asked to be published.** Previously a file with no `status:` in its frontmatter — an ordinary hand-authored note — was published on import and became AI-visible. Now only files that explicitly say `published` or `approved` are published; everything else is imported as a draft and waits for a human to approve it, with `status: draft` written down rather than left implied. Importing a plain Obsidian vault therefore yields drafts, not a published nest. Nests exported from ContextNest are unaffected: their documents carry an explicit status, so a round-trip still comes back published.

  Two further behaviours worth calling out:

  - An imported vault's `.versions/` history is preserved. A document whose version chain will not reconstruct now registers as a draft with its history intact, instead of having that history deleted so it could be republished from a fresh keyframe.
  - A failed upload deletes the half-filled nest rather than leaving it on the dashboard with silently missing documents.

  Requires `@promptowl/contextnest-engine` 2.1.0 for the `files[]` / `publish` / `discover` inputs on `context_import`.

- Converge the MCP and REST surfaces on the engine's operation catalog, cache the UI's reads, and make the board and dashboard usable at scale.

  ### MCP & engine convergence

  - **`structuredContent` on the eight tools `ctx` drives** (`src/mcp/tools.ts`, `src/mcp/routes.ts`, `src/mcp/server-routes.ts`) — tool results now carry a machine-readable payload alongside the prose, so a client no longer has to parse a human sentence to learn what happened. A conformance test pins every emitted shape to the engine's operation catalog (`test/mcp-catalog-conformance.test.ts`), so a drift between this server and the engine fails the suite instead of reaching a client.
  - **Denials and misses are errors, not prose** (`src/mcp/tools.ts`) — a permission denial and `context_get`'s not-found now set `isError`, which an agent can act on; previously both arrived as an ordinary successful result whose text happened to say no.
  - **`context_update` and `context_versions` accept `id`** (`src/mcp/tools.ts`) — an agent that already holds a node id no longer has to round-trip through a title, and a call that sends both echoes the resolved title rather than the one it guessed with.
  - **`context_get` stops pairing draft frontmatter with an approved body** (`src/mcp/tools.ts`) — the two came from different reads, so a document mid-review could be returned describing itself as a draft while carrying approved content.
  - **`context_overview` respects stewardship** (`src/mcp/tools.ts`, `test/overview-access.test.ts`) — the overview listed nodes the caller had no read grant on.
  - **Create, update, read, list and query run through the engine** (`src/nodes/service.ts`, `src/nodes/engine.ts`, `src/mcp/tools.ts`) — the community server no longer keeps its own copies of these operations. Document creation, updates, single-node reads, browsing and selector queries all go through the engine's canonical ops, which is what keeps the CLI, MCP and REST surfaces answering the same way. Requires `@promptowl/contextnest-engine` 2.1.0.

  ### Search & performance

  - **Search nests and documents from the dashboard** (`src/nodes/search.ts`, `src/app.ts`, `ui/src/components/QuickOpen.tsx`, `ui/src/lib/nest-search.ts`) — quick-open used to work only inside a nest; it now spans every nest the caller can read, and is no longer armed on pages where there is nothing to open. The cross-nest search fans out instead of walking nests in sequence, and logs the nests it had to skip rather than silently returning short results.
  - **A shared read cache for the UI** (`ui/src/lib/queries.ts`, `ui/src/lib/query-provider.tsx`, `ui/src/lib/api.ts`) — navigating back and forth re-fetched everything. Every structural GET and every document body now goes through one cache, with writes invalidating only the scope they touched (`test/nest-ui-cache.test.ts`).
  - **Discovery is cached and nest deletes are async** (`src/nodes/service.ts`, `test/discovery-cache.test.ts`) — a vault scan per request was the floor on every read; deleting a large nest no longer holds the request open.
  - **Import publishes in one batch** (`src/nodes/service.ts`, `src/shared/batch.ts`) — importing a folder paid one engine round trip per document. Publishing is batched behind a single shared helper, and a throw mid-batch no longer wipes healthy history.
  - **Filter the node listing over REST** (`src/nodes/query-routes.ts`, `test/list-filters.test.ts`) — the client was fetching a whole nest to show a filtered slice of it.

  ### Security

  - **CSP `frame-ancestors` clickjacking guard** (`src/app.ts`, `src/config.ts`, `src/shared/artifact-sandbox.ts`) — responses now carry a frame-ancestors policy, configurable for deployments that legitimately embed the UI, and served artifacts are sandboxed.
  - **Unmatched routes return a JSON 404** (`src/app.ts`, `test/spa-fallback-404.test.ts`) — the SPA fallback answered every unmatched path with the HTML shell, which broke MCP remote auth discovery: a client asking for a JSON discovery document got a page of markup and no way to tell it had missed.

  ### Board & workspace

  - **Reorderable, remembered board columns** (`ui/src/components/MaturityBoard.tsx`, `ui/src/lib/board-dimensions.ts`) — column order survives a reload, tag columns can be added and removed, and layout is scoped to the dimension it was arranged for instead of leaking across status/folder/tag views.
  - **The board uses the page width** (`ui/src/components/NestPageHeader.tsx`, `ui/src/components/MaturityBoard.tsx`) — the shell was narrow enough to force horizontal scrolling with columns to spare, and the external-edit status column was unlabelled.
  - **Helper text reads as points, not paragraphs** (`ui/src/components/MaturityBoard.tsx`, `ui/src/components/WorkflowsView.tsx`) — long continuous lines are split one point per line.
  - **Unloaded stats show a skeleton, not `0`** (`ui/src/components/ui/count-skeleton.tsx`, `ui/src/components/Dashboard.tsx`) — a dashboard mid-load claimed the user had nothing.

  ### Governance & documents

  - **"Reject" is the word for every negative verdict** (`ui/src/components/governance/ReasonDialog.tsx`, `ui/src/components/governance/ReviewQueue.tsx`) — "Decline" and "Reject" were used for the same action in different places. The review queue's empty state is also scoped to the reader's own review work, so an empty queue no longer reads as though the nest has nothing pending.
  - **`PATCH` on tags replaces instead of merging** (`src/nodes/service.ts`, `test/node-tag-removal.test.ts`) — a removed tag reappeared as soon as the document was reopened, because the write merged the incoming list into the stored one.
  - **Names are validated before they are submitted** (`ui/src/lib/nest-name.ts`, `src/nodes/service.ts`, `test/node-title-length.test.ts`) — a nest, folder or document title consisting only of punctuation is refused at the form rather than accepted and rendered blank.
  - **Rejected and unpublishable imported documents unstick** (`src/nodes/service.ts`, `test/rejected-node-edit.test.ts`) — a document whose version chain would not reconstruct could not be edited back into a publishable state.
  - **The vault re-indexes on delete, and approvals publish through the engine** (`src/nodes/service.ts`, `test/delete-reindex.test.ts`) — a deleted document lingered in query results until the next full scan.
  - **The approved-only view is reachable** (`src/nodes/service.ts`) — and approved versions are scanned once rather than per document.

  ### Fixes

  - Duplicate workflow edges are refused, and parallel wires between the same two nodes fan out instead of drawing on top of each other (`src/workflow/edge-routes.ts`, `ui/src/components/WorkflowsView.tsx`).
  - Coverage-gap tags in the ontology graph are clickable (`ui/src/components/OntologyGraphView.tsx`).
  - Duplicate Postgres connections are no longer opened per request (`test/db-postgres.test.ts`).
  - Notification digest batching windows widened so a burst stays one digest instead of fragmenting (`src/notify/email-render.ts`, `test/notify-digest.test.ts`).

### Patch Changes

- 1857c24: Record the verdict when an external edit is approved or rejected.

  Rejecting a direct filesystem edit left no trace. The document's history showed the approval of such an edit — the engine commits a version for it, and the server mirrors that into `node_versions`, which is what the history panel reads — but a rejection commits nothing, so the reviewer, the time and the reason were unrecoverable from the audit trail.

  The record already existed and was being discarded. `approveSuggestion` and `rejectSuggestion` each build a chain event carrying the acting reviewer, a timestamp, and the rejection reason or approval comment, return it, and persist nothing; this server read only the event id for its response. The verdict is now appended to the engine's own append-only chain-event log, so it survives without a new table, a migration, or a version number.

  A rejection still mints no version — it changes no content, and numbering one would renumber the chain for an event that never touched the document.

  `GET /nests/:nestId/nodes/:nodeId/versions` gains `externalEditVerdicts` alongside `versions`, and the version-history panel lists rejected external edits above the versions. The approve and reject endpoints now return `historyRecorded`, so a verdict that failed to reach the audit log is not reported as a clean success.

  The rejected content itself is unchanged: the engine keeps it permanently under `_archive/rejected/`. Surfacing that diff in the UI needs a read API the engine does not expose yet.

## 1.15.0

### Minor Changes

- a6661ff: Native PromptOwl connection: accept the short-lived `scope: "mcp"` service ticket on the per-nest `/nests/:id/mcp` transport (in addition to `/index`, server-level `/mcp`, `POST /context`, and `GET /nodes`), so a PromptOwl block granted read & write on one nest can reach that nest's write tools. Add two server-level bootstrap writes — `nest_create` and `context_create` — to the cross-nest `/mcp`, each gated by the same per-user write checks, suspend kill-switch, and license gate the per-nest path enforces. The MCP ticket and the one-click SSO login ticket are now mutually exclusive: `/auth/sso` refuses an `mcp`-scoped ticket and the MCP middleware refuses a ticket carrying a `jti`.
- e675f73: Prime documents: a per-document and per-tag review gate, so a nest no longer has to choose between reviewing everything and reviewing nothing. A **prime** document always goes through draft → pending → approved — it is the one thing `allow_self_approve` does not bypass, so even an owner's edit to the sales playbook lands as a draft.

  Whether a document is prime resolves in the existing steward scope order, **document → tag → nest**: a Prime switch in the document editor (owner/admin only, where `false` exempts one doc from an otherwise-prime tag), then the nest's configurable prime tags (`prime-document` by default), then not prime. A new per-nest `prime_only_review` setting flips a governed nest's default to self-publish so only prime documents queue for review; it is off by default, so existing nests keep their current posture on upgrade. Prime documents carry a badge in the nest's document list, and both settings are exposed on `GET`/`PATCH /nests/:id/settings` alongside `prime` on node create/update.

- Deletion requests as a first-class governance flow, a configurable maturity board with a reworked nest workspace, and MCP delete/move tools backed by a node-create path that no longer races itself.

  ### Deletion requests

  - **Request deletion of a document, folder or nest** (`src/db/migrations.ts`, `src/db/migrations.postgres.ts`, `src/governance/review-service.ts`, `src/governance/routes.ts`, `src/app.ts`) — a member without delete rights no longer has to ask an admin out of band. A new `deletion_requests` table keyed by target type carries the request through the same approve/reject vocabulary as a review, with the target resolved segment-aware so a folder named `policy` never matches `policies/` (`src/governance/title-resolver.ts`). Honouring the folder on approval is gated behind owner/admin, so a reviewer can clear a request without cascading a delete they were never entitled to.
  - **One Delete action, permission picks the dialog** (`ui/src/components/NestView.tsx`, `ui/src/components/DocumentEditor.tsx`, `ui/src/components/governance/ReasonDialog.tsx`, `ui/src/components/Dashboard.tsx`) — the same button either deletes or opens a reason prompt depending on what the caller may do; authors can delete their own documents outright, and a target with a request already open shows a pending badge to the requester instead of appearing untouched.
  - **Notifications on both ends** (`src/governance/notify-service.ts`, `src/notify/dispatch.ts`, `src/notify/email-render.ts`, `src/db/backfill.ts`) — admins hear about a new request, requesters hear the verdict. A one-shot backfill fills in notification titles that predate the change so old rows don't render blank.
  - **Same flow from an agent** (`src/mcp/tools.ts`) — a deletion an MCP client isn't permitted to perform is filed as a request rather than refused.

  ### Nest workspace

  - **Configurable maturity board** (`ui/src/components/MaturityBoard.tsx`, `ui/src/lib/board-dimensions.ts`) — a per-nest board that groups documents by lifecycle status, folder, or tag, with drag-to-move on the folder dimension. Columns come from the real lifecycle statuses rather than an invented set, and folder keys drop the `nodes/` prefix so the headers read as paths a user recognises.
  - **View switcher and a shared page header** (`ui/src/App.tsx`, `ui/src/components/NestPageHeader.tsx`, `ui/src/components/NestView.tsx`) — Documents, Board, Graph, Definitions and Workflows share one header and one spacing scale instead of each page inventing its own.
  - **Search moved into the header** (`ui/src/App.tsx`) — reachable from every nest page instead of only from the Documents list.
  - **Clickable tags and breadcrumbs** (`ui/src/App.tsx`, `ui/src/components/DocumentEditor.tsx`, `ui/src/components/OntologyGraphView.tsx`) — a nest-scope enabler lets a tag or breadcrumb segment navigate back into a filtered document list.
  - **Documents default to "Recent activity"** (`ui/src/lib/node-sort.ts`, `ui/src/components/NestView.tsx`) — the list opens on what changed last rather than alphabetical order.

  ### MCP & node integrity

  - **`context_delete` and `context_move`** (`src/mcp/tools.ts`, `src/nodes/service.ts`) — agents can delete and move documents through the same permission checks the REST routes enforce; an ambiguous title is refused rather than resolved to a guess. Resolving a node by id now hits the record directly instead of scanning the vault.
  - **Create no longer collides with itself** (`src/nodes/service.ts`) — creates serialize per node id and fail closed on the id check, a create that would collide with an existing node is refused, node-keyed rows no longer outlive the document they described, and the move-destination and duplicate-title races are closed.
  - **Approvers can move and delete a node under review** (`src/nodes/service.ts`) — the review lock stopped the one role able to resolve the review.
  - **Authors can find their own unsubmitted drafts** (`src/governance/version-service.ts`, `src/app.ts`, `src/mcp/tools.ts`, `ui/src/components/Dashboard.tsx`) — a draft that was never submitted was invisible to everyone including the person who wrote it.
  - **Document titles bounded at 120 characters** (`src/nodes/service.ts`, `ui/src/components/DocumentEditor.tsx`) — an unbounded title overflowed the breadcrumb and every list that rendered it.

  ### Fixes

  - The write path records why it skipped review instead of guessing a reason (`src/nodes/service.ts`, `src/nests/service.ts`).
  - Wiki links resolve by id, title or slug inside the review modal, matching the editor (`ui/src/components/NestView.tsx`).
  - Server timestamps without a zone read as UTC rather than local time (`ui/src/lib/dates.ts`).
  - The document title field is labelled and marked required instead of looking like static text (`ui/src/components/DocumentEditor.tsx`).
  - Long board card titles wrap instead of overflowing their column (`ui/src/components/MaturityBoard.tsx`).
  - Entering a nest folder-scoped opens Documents rather than the last view (`ui/src/components/NestView.tsx`).

- ba11aba: Per-version change logs instead of full-body copies. The version list (`GET /nests/:id/nodes/:nodeId/versions`) now returns each version's stored unified diff rather than reconstructing every body — opening the history panel of a long-lived document no longer replays the whole chain once per row and ships N full copies of the text. One body is fetched on demand from the new `GET /nests/:id/nodes/:nodeId/versions/:version`, which answers `200` with `content: null` when a version's chain can no longer be replayed, so one unreadable row doesn't fail the panel.

  Three fixes ride along. Draft saves now number through the engine's `nextVersion()` instead of the SQLite row count, closing the case where a DB lagging `history.yaml` grafted a second chain onto the first (duplicate versions, overwritten keyframes, "(no content)" from the graft point on) — a gated one-shot startup pass re-anchors documents already in that state and moves inline patches out into standalone `v{N}.diff` files. A duplicate `/versions` handler that shadowed the governance route is removed, so `resolvedBy` reaches the UI. And the diff viewer's line numbers no longer skip two, having learned to read the engine's `Index:` / `===` preamble as a header.

  Both version endpoints now take the same node-level read check as the document itself (`403` when the caller can't read the node). The list handler never had it, so on a public nest an anonymous reader could pull the change logs — and, through the new per-version endpoint, the reconstructed body — of a document that never cleared review, bypassing the approved-only rule public reads are otherwise held to.

  Requires `@promptowl/contextnest-engine` 1.3.0.

### Patch Changes

- 9447efe: Moving a document that isn't published no longer fails. A document stored with an empty tag list reads back with an undefined `tags` value, which the YAML serializer refuses to write — so every draft and pending-review move errored out while published documents (already cleaned by the publish path) moved fine. The same clean now runs on every write of a document that came from storage, which also covers the two import paths that reset a broken version chain or persist import metadata. The Documents list stops hiding "Move to folder" on a document awaiting review: owners, admins, and reviewers assigned to it are the callers the server already lets move one, and they now see the action.

## 1.14.0

### Minor Changes

- v1.14.0 — Microsoft Teams notifications, direct email to the people an event concerns, portable nest export/import, drag-and-drop document moves, and authors editing their own pending reviews.

  ### Notifications

  - **Microsoft Teams connector** (`src/notify/msteams.ts`, `src/notify/webhook.ts`, `src/notify/dispatch.ts`, `ui/src/components/SettingsPage.tsx`) — a second server-wide connector at full parity with Slack: the same governance events (review requested / approved / rejected, collaborator added, per-nest burst digests) post to a Teams channel as Adaptive Cards, configured via `MSTEAMS_WEBHOOK_URL` or the Settings card. Per-nest connector rows accept `channel: "teams"` with the same per-event filtering and `env:KEY` URL indirection as Slack. Delivery is fire-and-forget with a short timeout so a Teams outage never slows or fails the action that triggered it, and every user-controlled string in a card is escaped so a nest or document name cannot inject markup or links. The setting is named `msteams_*` because "teams" already means user groups in this product. `CONFIGURATION.md` documents creating the webhook through the Workflows (Power Automate) app, since Microsoft retired the classic Office 365 incoming-webhook connectors.
  - **Send test on the connector cards** (`src/app.ts`, `src/notify/webhook.ts`, `ui/src/components/SettingsPage.tsx`) — new `POST /admin/settings/test-notification` posts a message to the saved Slack or Teams webhook and reports whether it landed (200, 502 with the webhook's own reason, 400 for an unknown channel), so an admin can confirm a hook without waiting for a real governance event. The test renders through the same `formatBody` the live paths use, so what you see in the test is the real wire format. The route is gated on `serverAdminAllowed` — the same guard as reading and saving the webhook — instead of the license-admin-only check that previously 403'd a superadmin who could edit the URL but not test it.
  - **Emails go to the person the event concerns** (`src/notify/email.ts`, `src/notify/email-render.ts`, `src/governance/notify-service.ts`, `src/auth/routes.ts`, `src/nests/sharing-service.ts`, `src/governance/stewardship-service.ts`) — until now every notification email went to the shared `NOTIFY_EMAIL_TO` team inbox. A new direct-recipient send path emails the individuals involved: the invitee gets their nest invite (plus a Hootie inbox row surfaced by ContextNest Desktop), a new teammate gets their sign-in email carrying the one-time temporary password, every newly-assigned steward is told their role and scope, reviewers are emailed on submit, the submitter is emailed the verdict, and team members are emailed when their team is shared onto a nest. The per-status email copy collapsed into one status-keyed template table and the "shared" copy now addresses the recipient in the second person. All sends are best-effort — a dead SMTP never fails the invite, share, or review. The SMTP path gained a connection pool, a per-second rate limit, and backoff retry on provider throttle replies so a reviewer fan-out cannot trip a "too many emails" 550.
  - **Email sign-off** (`src/notify/email-render.ts`) — the "Automated governance notification" footer is gone and emails sign off as Community Nest.

  ### Nest portability

  - **Export a nest as a portable bundle** (`src/nests/bundle-service.ts`, `src/nests/routes.ts`, `ui/src/components/ConnectModal.tsx`) — `GET /nests/:id/export?format=bundle` (owner/admin) streams a `.zip` of the nest's documents plus engine version history (`.versions`) and nest config, so a nest can move to another ContextNest host. Documents are serialized from their approved/published state so they re-import published rather than as drafts; `?includeDrafts=1` also ships unapproved drafts, offered as an "Include draft documents" toggle in the Connect dialog's new Export dialog. Identities, attribution, and the governance overlay (stewards, reviews, comments, definitions, edges, grants) deliberately do not travel — the importer owns and re-governs the new nest. When an approved version cannot be reconstructed the document is skipped rather than shipping working-copy bytes stamped `status: published`.
  - **Import a bundle through the existing importer** (`ui/src/components/ImportFolderModal.tsx`, `ui/src/lib/markdown-split.ts`, `src/fs/vault-import.ts`) — the Import dialog gains a source selector (folder vs file) whose file picker accepts an exported nest `.zip` (expanded client-side), loose markdown/text files, or a whole-nest "Export as markdown" file split back into individual documents. Everything routes through the existing `POST /nests/import`; there is no second endpoint. `.context` is allowed alongside `.versions` through the import path so nest config and version history survive the round trip.

  ### Governance

  - **Authors can revise their own pending-review submissions** (`src/nodes/service.ts`, `src/governance/review-service.ts`, `src/shared/node-write-lock.ts`, `ui/src/components/DocumentEditor.tsx`) — submitting a document used to lock its own author out with a 423 until a steward ruled, forcing withdraw-and-resubmit to fix a typo. The author may now keep editing: the edit lands as a new draft version through the engine's normal hash-chain append and the open review repoints onto it — same review row, no re-notify, no duplicate — so the steward reviews the final edited version. Non-authors stay locked, and an auto-publishing owner editing their own pending review stays in review rather than self-approving past it. The repoint runs in a single transaction so the review pointer and version status can never disagree, and the editor shows the author a "still under review" notice while they revise.
  - **Review resolution serialized against author edits** (`src/shared/node-write-lock.ts`, `src/governance/review-service.ts`, `src/governance/routes.ts`, `src/mcp/tools.ts`) — approve/reject/cancel now take the same per-node write lock as `updateNode` and read the current version inside it, instead of resolving against a version read in the route before the operation ran. A concurrent author edit can no longer land between the read and the resolution, orphaning the fresh revision. REST and MCP approve/reject also echo the version actually resolved rather than a stale pre-read.

  ### Documents

  - **Drag-and-drop documents into folders** (`ui/src/components/NestView.tsx`) — drag a document onto a folder to move it, with a loading toast that swaps to success carrying an Undo action, and a keyboard-accessible "Move to folder" menu item and dialog behind the same mover so the flow is not drag-only. Document rows act as drop proxies for the folder they sit in, hovering a collapsed folder for ~600ms springs it open so nested targets are reachable mid-drag, and invalid targets (a document's current folder) show the no-drop cursor instead of highlighting. Move permission mirrors the edit gate exactly — stewardship scope plus the pending-review lock. Folder-onto-folder is intentionally not implemented: the server moves one document per call, so it would be N non-atomic moves.

  ### Fixes

  - **Discard actually discards** (`ui/src/components/DocumentEditor.tsx`, `ui/src/lib/draft.ts`) — blur-autosave wrote to the server, and blurring a field to click the back arrow fired that write before the "Unsaved changes" dialog appeared, so Discard only navigated away and left the edit saved (and spun up one version per field exit). Blur now parks edits in localStorage; the server is written only on an explicit Save or Save-and-leave, and Discard clears the parked draft and reverts to the loaded snapshot. Reopening a document restores its draft only when it was taken from the version just loaded — a newer server copy wins — and the draft store evicts the stalest other draft to fit, reporting failure so the editor can warn that a reload would lose the edits.
  - **Toggle blocks render a working disclosure control** (`ui/src/components/MarkdownEditor/editor-styles.css`, `ui/src/components/MarkdownEditor/extensions/Toggle.ts`) — TipTap renders a `div[data-type="details"]` rather than a native `<details>`, so the CSS targeting `.ProseMirror details` never matched: the chevron had no styling and the summary fell back to a list-item disc, reading as a stray bullet with no way to expand. The CSS retargets the data attribute, the chevron rotates on open, and a single click on the summary header toggles the block (double-click still edits the header text).
  - **Slack review events no longer post twice** (`src/notify/dispatch.ts`) — review events fired down both the immediate dispatch path and the debounced digest, and both hit the same server-wide Slack webhook. The implicit server-slack connector now carries the same digest guard Teams already had, so the digest owns review events and dispatch keeps only `run_failed`.
  - **Direct-recipient emails stay out of the team digest** (`src/notify/notify.ts`) — the email opt-out was all-or-nothing per debounce window, so an invite or verdict sharing a window with a non-skipped event still had its line folded into the team digest. The digest body is now built from non-skipped events only; Slack and Teams still receive everything.
  - **Multi-recipient emails use Bcc** (`src/notify/email.ts`) — a reviewer fan-out or team share put every address in the To header, leaking the roster to every recipient. Two or more recipients now go out via Bcc; a single recipient is unchanged.

  ### CI

  - **Auto-deploy dev on merge to development** (`.github/workflows/deploy-dev.yml`) — a workflow that builds the image and deploys the `community-nest-dev` Cloud Run service when a PR merges into `development`, mirroring the manual `deploy-dev.ps1` step for step (service account, GCS nest volume, Cloud SQL, VPC, scaling, public access). Secrets moved out of the script into `DEV_*` repository secrets, leaving `PROD_*` free for a later main pipeline; deploys serialize rather than cancelling in flight so a second merge cannot interrupt a docker push or Cloud Run rollout mid-way.

## 1.13.0

### Minor Changes

- v1.13.0 — dashboard cleanup, faster My Work, governance auto-publish, and safer email/upload handling.

  ### Governance

  - **Auto-publish owner & admin edits** (`src/nodes/service.ts`, `ui/src/components/NestSettingsModal.tsx`) — the nest "Allow self-approve" flag is redefined as an owner/admin governance bypass: with it on, create/update by an owner or admin publishes immediately instead of landing as a draft awaiting review. Editors and reviewers are unchanged (still draft → submit → review). Applies across REST and MCP via the shared node service, respects the pending-review edit lock, and the setting is renamed to "Auto-publish owner & admin edits".
  - **Approval inbox hidden from non-approvers** (`src/governance/review-service.ts`) — the `/me/work` "waiting on me" bucket previously listed pending reviews from nests where the caller was only an editor or viewer, showing an Approve/Reject affordance the server would reject. It is now filtered to nests the caller can actually approve in, resolved per distinct nest and cached briefly so the polled inbox stays cheap.

  ### Dashboard & My Work

  - **Nests and My Work in tabs, faster load** (`ui/src/components/Dashboard.tsx`, `ui/src/lib/api.ts`) — dashboard annotate runs in parallel and My Work uses a single visible-nests query with a scoped review queue and paginated inbox.
  - **Delete unwanted unsynced folders** (`src/nests/unsynced-service.ts`, `src/nests/routes.ts`, `ui/src/components/Dashboard.tsx`) — new `DELETE /nests/unsynced/sync` (server-admin gated, same safe-name and live-nest-root guards as sync) plus a confirmed Delete button on each unsynced card, so leftover imports can be removed instead of only synced.
  - **Importer + date on imported nest cards** (`ui/src/components/Dashboard.tsx`) and the stray "0" / duplicate Overview stat tiles on non-imported cards are gone.

  ### Teammates & nests

  - **Teammate list polish** (`ui/src/components/TeammatesPage.tsx`) — a "You" badge, search, and role filter.
  - **Private nests stay private** (`src/nests/service.ts`) — admins no longer see other users' private nests in the list.

  ### Fixes

  - **Email validation hardened** (`src/config.ts`, `src/auth/routes.ts`, `ui/src/components/*`) — `isEmailish` delegates to zod's email validator (rejecting junk like `*'/*'/8////@gmail.com`) while keeping the explicit CR/LF reject to close header-injection shapes; the UI validates email before adding a collaborator, steward, or team member.
  - **Video upload cap** (`src/config.ts`, `src/nests/asset-routes.ts`) — default 30 MB, configurable via `VIDEO_MAX_MB`, kept under Cloud Run's request-body limit so oversized videos fail with a clear message instead of a bare 413.
  - **Editor** (`ui/src/components/MarkdownEditor/MarkdownEditor.tsx`) — usable "Turn into Toggle" and the block menu survives paste.
  - **Draft publish-in-place** (`src/nodes/service.ts`) — upsert the version on publish-in-place to avoid a UNIQUE clash.
  - **Postgres counts** (`src/governance/review-service.ts`, `src/nests/service.ts`) — review-queue and nest-list totals are coerced to `Number` so counts are correct on Postgres.

## 1.12.0

### Minor Changes

- v1.12.0 — reliable external MCP connections, a tabbed dashboard, and a UI read cache that ends the constant reloading.

  ### MCP & connections

  - **Collaborator MCP connections unblocked** (`src/app.ts`, `src/mcp/tools.ts`, `src/auth/routes.ts`, `ui/src/components/ConnectModal.tsx`) — external clients (PromptOwl, Claude Desktop, Cursor) intermittently showed "no tools found" for users with valid access. The per-nest transport gate now runs at read tier (MCP Streamable HTTP is always POST; mutating tools re-check their own permission inside `runTool`), middleware denials on the MCP path return a proper JSON-RPC error envelope with an actionable reason instead of plain `{error}` JSON, and the Connect dialog mints a user-level key instead of silently nest-scoping the account's single key (rotate accepts `nest_id: null` to clear a stale scope). Backed by a full role-permission matrix suite (`test/mcp-permission-matrix.test.ts`).

  ### Dashboard

  - **Nests and My Work split into tabs** (`ui/src/components/Dashboard.tsx`) — with a large review backlog the stacked My Work list pushed the nest grid below a huge scroll; nests stay the default tab.
  - **Faster dashboard load** (`ui/src/components/Dashboard.tsx`, `ui/src/lib/api.ts`) — banner counts derive from the nest list's `document_count` instead of the slow `/stats` round-trip, and `/unsynced` + `/me/work` no longer gate the page loader; they stream in as they land.
  - **AI Ready card no longer shows 0 for live documents** (`ui/src/components/Dashboard.tsx`) — the count now includes `published` alongside `approved`, matching `LifecycleStatusBadge`.

  ### UI read cache

  - **Structural nest reads cached** (`ui/src/lib/api.ts`) — a 30s in-memory cache with in-flight dedupe for the slow-changing GETs (`listNodes`, `listNests`, `getNest`, `getNestSettings`) stops large nests from re-fetching everything on every navigation. True stale-while-revalidate (expired entries paint instantly and revalidate in the background), a generation counter closes the stale-after-edit race, and any successful mutation under `/nests/{id}` — including streaming import and folder sync — busts the affected cache plus the nests list. The cache clears on every auth transition so a user switch is never served the previous identity's data (`ui/src/auth/AuthContext.tsx`). Live document bodies, search, and feeds are intentionally uncached.

  ### Fixes

  - Invited badge cleared on every sign-in flow — PromptOwl device flow, SSO ticket, and OIDC logins left `is_invited=1`, so a stale badge lingered and a later re-invite could clobber an active account; the clear moved into `createSession`, the one point all browser sign-ins route through (`src/auth/sessions.ts`).

## 1.11.0

### Minor Changes

- v1.11.0 — teams as shareable member groups with PromptOwl sync, OIDC SSO, a governance activity feed, superadmin management from the UI, video assets, and type-appropriate editors.

  ### Teams & sharing

  - **Teams — shareable member groups with per-member roles** (`src/governance/teams-service.ts`, `src/governance/team-routes.ts`, `src/nests/nest-team-routes.ts`, `ui/src/components/TeamsPage.tsx`, `ui/src/components/TeamShareManager.tsx`) — teams as first-class member groups, attachable to nests from the share dialog with per-member roles and team-aware access resolution. Management is role-gated, roster writes are atomic against the resolved account email, and sharing a team onto a nest requires editor+ plus a relationship to the team (view-only members can no longer attach a team the owner can't undo).
  - **PromptOwl team import + one-click sync** (`src/governance/promptowl-teams.ts`, `ui/src/components/PromptowlTeamsPanel.tsx`) — import PromptOwl teams into Community and keep them synced with one click, gated behind a `PROMPTOWL_TEAMS_ENABLED` settings flag with live-refreshing settings.

  ### Authentication

  - **OIDC SSO — Microsoft Entra ID + Google** (`src/auth/oidc.ts`, `ui/src/components/Login.tsx`, `ui/src/components/SettingsPage.tsx`) — superadmin-configurable OIDC sign-in with issuer presets, RP-initiated logout, graceful JIT provisioning, RS256 pinning, an `email_verified` policy, per-endpoint rate limits with fetch timeouts, and an SSO-only sign-in configuration.
  - **Department auto-tagging** (`src/config.ts`, `src/nodes/service.ts`) — optional department tags sourced from the OIDC department claim, with case-insensitive dedupe; claim capture never fails login.

  ### Governance & admin

  - **Activity feed in the review queue** (`src/governance/feed-service.ts`, `ui/src/components/governance/ReviewQueue.tsx`) — comments join changes in the review queue, with a counts-driven chip, load-more paging, parallel `canReview` resolution, and a feed license gate.
  - **Superadmin management from the UI** (`src/app.ts`, `ui/src/components/TeammatesPage.tsx`) — DB-backed grant/revoke of superadmins inline on the user card; superadmin peers are protected from reset/remove, grant races return 409, and revoke is hidden on your own row.

  ### Documents & editor

  - **Video assets + editor media upload** (`src/nests/asset-routes.ts`, `ui/src/components/MarkdownEditor/MarkdownEditor.tsx`, `ui/src/components/DocumentViewer.tsx`) — nest assets accept mp4/webm video alongside images with per-type size caps (images 10 MB, video 100 MB) enforced without raising the global request cap; the editor's Upload menu becomes "Image or video" with drag-drop, and both editor and read view render same-origin asset video URLs as an inline player. Asset serving sends `X-Content-Type-Options: nosniff`.
  - **Type-appropriate editors** (`ui/src/components/TableSourceEditor.tsx`, `ui/src/lib/csv-table.ts`) — source editing for tool and table nodes, with spreadsheet paste, CSV/TSV upload via a shared upload helper, and the editor locked during in-flight uploads.
  - **Raw node fetch** (`src/nodes/routes.ts`, `src/shared/artifact-sandbox.ts`) — `?format=raw` returns node bodies directly, with artifact responses sandboxed and `nosniff` on every raw path.
  - **Author + collaborators on documents** (`ui/src/components/AuthorshipChips.tsx`) — author and collaborator chips on document cards and details; the roster is withheld from public readers.
  - **Nest rename** (`ui/src/components/RenameNestDialog.tsx`) — rename a nest from the dashboard or nest view; the dialog sends only dirty fields and no longer clobbers an in-flight inline rename.

  ### Settings

  - **Per-type content toggles** (`src/config.ts`, `ui/src/components/SettingsPage.tsx`) — enable/disable content types server-wide, enforced on the bulk publish path and noted in the MCP `context_create` description; the workflow plane is labeled Beta (`ui/src/components/ui/beta-badge.tsx`).

  ### Fixes

  - Folder import recovers unpublishable docs, drops stale governance state, and shows progress; recovered docs land as `pending_review` without a refetch flash (`src/fs/vault-import.ts`, `ui/src/components/ImportFolderModal.tsx`).
  - Shared safe-copy clipboard util with a fallback for insecure contexts, applied everywhere including `CodeBlock` (`ui/src/lib/clipboard.ts`).
  - Workflow canvas shelf reflows to the visible width instead of clipping right-side cards (`ui/src/components/WorkflowsView.tsx`).
  - Nest description fields use a textarea and expand for long text; the nest Overview shows the real edited-this-week count; Overview and External Edits tabs show a loader while fetching (`ui/src/components/NestView.tsx`).
  - Collaborator chips are coloured per person so initials stop colliding; the redundant creator avatar beside the full email is dropped.

## 1.10.0

### Minor Changes

- v1.10.0 — a live workflow canvas with schedules and claimable runs, a data-driven connector/trigger layer, governed CSV tables, documents-as-a-repo folders, artifact version history, and configurable trace retention.

  ### Workflow orchestration

  - **Live workflow canvas** (`ui/src/components/WorkflowsView.tsx`) — an n8n-feel canvas wired to the edges API, with a 2-tab model (Canvas | Activity), a canvas shelf search, and grab-as-context commands. Replaces the standalone Runs and Edge-Types pages, which are folded into the canvas surface.
  - **Schedules** (`src/workflow/schedule-routes.ts`, `src/workflow/scheduler.ts`) — a Schedules tab separate from Runs, backed by a server-side scheduler.
  - **Claimable run queue** (`src/workflow/run-routes.ts`) — `?unclaimed=true` plus `GET /runs/:id/bundle` let external runners claim and pull work; run inputs, review-verdict notifications, and failed-run errors surface in the list.
  - **Sub-agent controls** — a dedicated Run tab with a sub-agent tree and upfront cap validation, a richer parent-run picker on the Run trigger form, and admin-editable sub-agent recursion caps driven from the server (`src/config.ts`, `ui/src/components/SettingsPage.tsx`).
  - **Tool node type + HITL watchers** (`src/workflow/run-routes.ts`, `src/workflow/env-routes.ts`) — a tool node type, a per-nest env store, and human-in-the-loop watcher notifications.

  ### Connectors & triggers

  - **Connector dispatch engine** (`src/notify/dispatch.ts`, `src/notify/connector-routes.ts`) — channels modeled as data, one brick per direction, surfaced as a connectors card in Activity and on the agent panel.
  - **Inbound trigger hooks** (`src/workflow/hook-routes.ts`) — tokenized listener URLs with platform presets for inbound triggers.
  - **Email connector** (`src/notify/email.ts`) — SMTP dispatch with credential verification before save.

  ### Governed tables

  - **Table content type** (`src/tables/service.ts`, `src/tables/query.ts`) — CSV as a governed, deterministically queryable fact store.
  - **CSV/TSV input** (`ui/src/lib/csv-table.ts`, `ui/src/components/TableViewer.tsx`, `ui/src/components/MarkdownEditor/TableControls.tsx`) — table input via CSV/TSV paste and file upload, with CSV round-trip and a large-table fallback.

  ### Documents as a repo

  - **Folder tree + move API** (`src/nodes/service.ts`, `ui/src/components/FolderTree.tsx`) — documents as a real repo: folder tree with drag-and-drop, a move API that relocates a document (and everything under it) to another folder, a breadcrumb folder picker, type-icon chips, and a nestable New Folder dialog.

  ### Artifacts

  - **Artifact version history** (`ui/src/components/ArtifactViewer.tsx`, `ui/src/components/governance/VersionHistoryModal.tsx`) — version history, preview, rollback, and source editing, with preview cache-busting on restore.

  ### Telemetry

  - **Configurable trace retention** (`src/telemetry/trace-log.ts`) — configurable retention plus a per-nest steward trace view, backed by an `api_events(nest_id, id)` index for per-nest trace queries.

  ### Settings & configuration

  - **Server settings in the database** (`src/db/settings.ts`, `src/config.ts`) — every server option lives in Settings (Anthropic key, Slack connector, public base URL); server settings and the license key persist to the DB instead of an ephemeral `.env`. A `MANUAL_SIGN_IN` flag gates email/password sign-in separately from PromptOwl.

  ### Engine convergence (Phase 0)

  - **Engine sync + MCP guard** (`src/mcp/tools.ts`, `scripts/check-mcp-schemas.mjs`) — engine 1.2.1 bump with the engine/CLI sync discipline, a per-node access gate enforced on MCP retrieval (`resolveLlmBody`), and a divergence guard against new inline MCP schemas.

  ### Guide

  - **In-app manual** (`ui/src/components/GuidePage.tsx`) — a "How it works" page from the user menu covering concepts, the governed loop, and the APIs.

  ### Fixes

  - Proper email validation with field-keyed errors on notification config; SMTP credentials verified before saving.
  - Dropped a misspelled Vercel automation bypass-cookie header.
  - Hierarchical folder tree keeps indenting past level 6.
  - Save on blur instead of every keystroke, with a Save/Saved state; per-node writes serialized so versions stay consistent.
  - `[[` autocomplete stays on-screen and instant; table controls stay inside the editor viewport; version-history content stays on-screen in a wider dialog.
  - Pinned LinearRouter for upstream routing parity.

## 1.9.0

### Minor Changes

- v1.9.0 — the workflow plane (typed edges, edge-type registry, governed runs, sub-agent runs), an email connector with per-nest digests, glossary definitions, markdown image uploads, and a unified document/folder sharing model.

  ### Workflow plane ("turing" track)

  - **Typed edges + edge-type registry** (`src/workflow/edge-routes.ts`, `src/workflow/edge-type-routes.ts`, `ui/src/components/EdgeTypesPage.tsx`) — a steward-articulated vocabulary of relations (`next`, `on-failure`, `derives-from`…). Flow edges (`is_flow`) participate in control flow and are DAG-validated; cycles are rejected with a 409 naming the path. Edge conditions run in three modes: `structured` (JSON predicate, a `term` resolves against the definitions glossary), `nl` (LLM-judged at execution, rationale logged), and `open`. Whole plane is off by default behind `FEATURE_WORKFLOW_PLANE`; every plane route 404s until enabled.
  - **Governed runs** (`src/workflow/run-routes.ts`, `src/workflow/run-service.ts`, `ui/src/components/RunsPage.tsx`) — the server never executes; external runners do. `POST /nests/:id/run/:agent` returns the complete executable bundle (agent node instructions, reachable flow-edge subgraph with conditions and referenced glossary definitions, and a `run_id`) in one round-trip. Steps are logged via `POST /runs/:id/steps` with server-assigned monotonic `seq`; terminal state is final (further steps/PATCH 409). Runs are replayable — recorded deterministic reads reproduce the identical read-set.
  - **Sub-agent runs** (`src/workflow/run-service.ts`, `test/subagent-runs.test.ts`) — a run can spawn nested runs via `parent_run_id`, gated separately behind `FEATURE_SUBAGENT_RUNS` because recursion is the risky surface. Bounded by `SUBAGENT_MAX_DEPTH` (height, clamped 1..32, default 8), `SUBAGENT_MAX_CHILDREN` (width, default 16), and `RUN_MAX_STEPS` (default 10000) so a runner can't fork-bomb the DB. Turning the plane off forces sub-agent runs off too.
  - **Workflow MCP tools** (`src/mcp/workflow-tools.ts`) — build + execute tools thread request origin into the plane so agents can drive edges and runs over MCP.

  ### Email connector + notification digests

  - **SMTP governance notifications** (`src/notify/email.ts`, `src/notify/email-render.ts`) — structured HTML notifications for review/approval/share events over `smtp://`/`smtps://` (nodemailer 9.0.3, exact pin). Requires `SMTP_URL` + `NOTIFY_EMAIL_FROM` + `NOTIFY_EMAIL_TO`; empty = off; also configurable in Settings.
  - **Per-nest digests** (`src/notify/notify.ts`) — events buffer per nest for `NOTIFY_DEBOUNCE_MS` (default 15000) so bursts (e.g. sharing a nest with a whole team) collapse into a single message instead of one per event.

  ### Glossary definitions

  - **Table-based ontology + real-time lookup** (`src/definitions/routes.ts`, `ui/src/components/DefinitionsPage.tsx`) — per-nest glossary of defined terms with a rename-collision guard and transaction-scoped reads; terms resolve inside structured edge conditions.

  ### Document authoring

  - **Images in markdown docs** (`src/nests/asset-routes.ts`, `ui/src/components/MarkdownEditor/MarkdownEditor.tsx`) — per-nest asset upload, serving, and editor insert.
  - **Ontology graph structure layer** (`ui/src/components/OntologyGraphView.tsx`, `src/nodes/graph-service.ts`) — nest + folder structure surfaced in the ontology view; slug-form wikilinks resolve into edges.
  - **Tabbed server settings** (`ui/src/components/SettingsPage.tsx`) — server settings reorganized into tabs with a single global save.

  ### Sharing & governance

  - **Unified document/folder sharing (grants model)** (`src/governance/grants-service.ts`, `src/nests/grant-routes.ts`) — one grants model for humans and agents; grants are honored under stewardship and on retrieval routes.

  ### Fixes

  - **Reject bare-root folder share targets** (`src/nests/grant-routes.ts`) — a bare-root folder target would have shared the whole nest.
  - **Imported document title derived from filename** (`src/governance/title-resolver.ts`, `test/import-nest.test.ts`).
  - **Edge traversal hardened** — node-id traversal guarded and the DAG check made atomic; edge flag gated per-route (not via `use("*")`) to unwedge the router; corrected seed call, cycle-path 409, and term-validation catch.
  - **Workflow-plane UI gated on the server feature flag for all users** (`ui/src/App.tsx`) so plane surfaces stay hidden until enabled.
  - **Shareable deep-link params for nest sub-pages** (`ui/src/App.tsx`); inline version diff in the governance diff viewer (`ui/src/components/governance/DiffViewer.tsx`).
  - **Notification hardening** — digest email line breaks preserved; empty `NOTIFY_DEBOUNCE_MS` guarded; admin-set SMTP timeout query param no longer duplicated; email envelope fields validated at the config boundary.

  ### Configuration & docs

  - New `FEATURE_WORKFLOW_PLANE`, `FEATURE_SUBAGENT_RUNS`, `SUBAGENT_MAX_DEPTH`, `SUBAGENT_MAX_CHILDREN`, `RUN_MAX_STEPS`, `SMTP_URL`, `NOTIFY_EMAIL_FROM`, `NOTIFY_EMAIL_TO`, and `NOTIFY_DEBOUNCE_MS` documented in `.env.example` and `CONFIGURATION.md`; `API.md` updated for the new endpoints; new `WORKFLOW_PLANE.md` documents the runner contract and guardrails.

## 1.8.0

### Minor Changes

- v1.8.0 — a server-level agent entry point, an activity trace, an external-sync primitive, scheduled agent/skill nodes, and a Slack connector.

  ### Agent entry point

  - **Connect once to the server instead of per nest** (`src/mcp/server-routes.ts`, `src/app.ts`) — a new server-level surface: `GET /llms.txt` (public agent manual covering endpoints, MCP, selector grammar, hop/skip retrieval, the `ctx` CLI and npm packages), `GET /index` (the caller's grounded nest index as markdown or json), and a stateless `ALL /mcp` endpoint exposing `nest_index` plus cross-nest read tools that take a `nest` id-or-name argument. Reads are gated per call via `resolveNestPermission` and nest-scoped API keys are honored; write tools stay on the per-nest `/nests/:id/mcp` endpoint so cross-nest mutation through one socket can't slip past authz.
  - **Agent docs page** (`ui/src/components/AgentDocsPage.tsx`, `ui/src/App.tsx`) surfaces the manual in-app.

  ### Superadmin activity trace

  - **One row per API request / MCP tool call** (`src/telemetry/trace-log.ts`, `ui/src/components/ActivityTracePage.tsx`) — an operator audit surface (who / what / where / outcome / duration) covering every API and MCP call in one place, with pagination. Writes are best-effort fire-and-forget with a rolling 14-day retention window pruned opportunistically. Distinct from product telemetry: it never leaves the server and ignores `TELEMETRY_ENABLED`. Postgres parity and MCP audit coverage added in review.

  ### External sync primitive

  - **`GET /nests/:id/changes?since=`** (`src/nodes/query-routes.ts`) — a change-feed endpoint for external mirrors that uses approval time as the change signal for public readers, so downstream copies only ever see approved content.

  ### Scheduled agent / skill nodes

  - **Agent and skill node types with a schedule** (`src/nodes/service.ts`, `src/nodes/routes.ts`, `ui/src/components/DocumentEditor.tsx`, `ui/src/components/NestView.tsx`) plus a `GET /runnables` orchestrator API that lists runnable nodes with their schedules. Schedule is string-coerced at the API boundary and surfaced in the UI.

  ### Slack connector

  - **Admin-configured incoming-webhook notifications** (`src/notify/slack.ts`, `ui/src/components/SettingsPage.tsx`) — optional team notifications for governance/review events (Settings → Slack webhook URL; empty = off). Deliberately minimal: a plain fetch with a short timeout, fire-and-forget so a Slack outage never slows or fails the triggering action. Notifications include the document title and folder; Slack mrkdwn control chars are escaped, the webhook input is masked, and a bad URL warns once then goes quiet. No new dependencies.

  ### Security & fixes

  - **Path-traversal guard on node ids** (`src/shared/node-id.ts`, `src/nodes/routes.ts`, `src/mcp/tools.ts`) — a centralized traversal guard applied across every node router, closing cross-tenant read/write/delete via crafted node ids.
  - **MCP nest-name resolution scoped to the caller** (`src/mcp/tools.ts`, `src/governance/title-resolver.ts`) — colliding nest names no longer resolve across tenants.
  - **Foldered node sub-routes served correctly** (`src/app.ts`) — `/hosted`, `/annotations`, and sibling sub-routes now resolve for documents in nested folders.
  - **Postgres schema/migration parity** (`src/db/migrations.ts`, `src/db/migrations.postgres.ts`) — `node_deletions` added to the Postgres schema with a migration-parity guard so the two backends stay in lockstep.

  ### Configuration

  - New `DB_*` / Slack-related settings documented in `.env.example` and `CONFIGURATION.md`; `API.md` updated for the new endpoints.

  ### Tests

  New/expanded coverage: `test/admin-trace.test.ts`, `test/agent-entrypoint.test.ts`, `test/changes-since.test.ts`, `test/migration-parity.test.ts`, `test/node-id-traversal.test.ts`, `test/runnables.test.ts`, `test/slack-connector.test.ts`, `test/wiki-node-filter.test.ts`, plus additions to `test/annotations.test.ts` and `test/db-postgres.test.ts`.

## 1.7.0

### Minor Changes

- e187c6d: v1.7.0 — anchored inline comments, delegated nest admins, nested folders, and a documented deterministic-retrieval API.

  ### Comments → anchored inline annotations

  - **Replaces the comment modal with anchored inline threads** (`ui/src/components/AnnotationsPanel.tsx`, `ui/src/lib/anchor-highlight.ts`): highlight text in a markdown doc to pin a comment to that quote (W3C TextQuote anchor), painted via the CSS Custom Highlight API; click/hover a highlight to focus its thread in a sticky rail. A new comment-mode toggle forces the rendered read view so select-to-comment works without TipTap stealing focus. `CommentsPanel.tsx` and its modal trigger are deleted — no backend/schema change, reuses the existing `/annotations` service.
  - **Postgres-safe annotation ordering** (`src/annotations/service.ts`) — `ORDER BY rowid` (a SQLite-only pseudo-column) replaced with `ORDER BY id`, a portable deterministic tiebreak.
  - **`context_comments` gated on approval** (`src/mcp/tools.ts`) — the MCP tool resolved threads directly, bypassing the approved-only gate `context_get`/`context_export` enforce; an unapproved draft's quoted text and paraphrased comment bodies could leak through this side door. Now refuses with the same "no approved version yet" message as the other content tools.
  - **Document list — sort by name, recency, or comment count** (`src/nests/routes.ts`, `ui/src/components/NestView.tsx`) — new `countThreadsByNode` aggregate and `GET /nests/:nestId/comment-counts` power a "Most comments" sort option alongside name and recently-edited.

  ### Delegated nest administration

  - **Nest owner/admin collaborators can manage stewards, settings, and MCP sharing** (`src/governance/stewardship-service.ts`, `src/app.ts`, `src/mcp/tools.ts`, `ui/src/components/TeammatesPage.tsx`) — `canManageStewards` is now nest-aware (server admin OR nest owner/admin) instead of requiring the license admin; `PATCH /nests/:id/settings` and MCP `context_share_nest` now follow the same rule as REST, closing a prior TODO.
  - **Follow-up hardening** (`f865dad`): the steward roster endpoint (`/nests/:id/stewards`) is excluded from public/anonymous read (was leaking steward emails/roles on anon-owned nests); disabling stewardship (which hard-deletes stewards and pending reviews) stays owner/server-admin-only so a delegated admin can't wipe governance state. Dead `canManageWith` removed from `src/governance/roles.ts`.

  ### Nested folders

  - **Documents can be created at any depth under `nodes/`** (`src/nodes/service.ts`, `src/nodes/routes.ts`, `src/mcp/tools.ts`) — creation previously flattened everything to `nodes/<slug>`; `createNode` now accepts a per-segment-slugified `folder` (traversal chars collapse, empty segments drop, max 8 levels) via REST `POST /nodes` and MCP `context_create`.
  - `DocumentEditor` gets a Folder field (datalist of existing paths); `NestView` groups its Contents list by full folder path with depth-indented headers instead of only the first path segment.

  ### Deterministic retrieval API

  - **Connect modal — new API tab** (`ui/src/components/ConnectModal.tsx`) documents the previously-unlisted `POST /nests/:id/context` endpoint (selector + hops + max_tokens → assembled markdown with a hops_used/nodes_traversed trace), the selector grammar (`#tag`, `type:`, `[[Title]]`, `scope:`, `+AND`/`|OR`/`-NOT`), and 1-hop vs multi-hop semantics; the CLI tab cross-references it. MCP tab now lists all 21 registered tools (was undercounting at 18); snippets wrap instead of truncating, and open-mode snippets drop the now-unneeded auth flags.
  - **`context_query`/`context_resolve` take a caller-set `hops`** (default 2, was hardcoded) with matching REST support, then hardened: `normalizeHops` treats `null`/`undefined` as the default instead of `0`, and caps depth at `MAX_HOPS=10`. Both tools are now routed through `resolveLlmBody` so hop-expanded neighborhoods can no longer surface unapproved/draft bodies — previously only `context_get`/`search`/`export` enforced that gate.
  - **Graph click-to-query** (`ui/src/components/OntologyGraphView.tsx`) — clicking a node in the ontology graph surfaces its engine selector (`[[Title]]` / `#tag`) with a copy button and a 0-3 hop picker that drives both the highlighted neighborhood (BFS over visible links) and a matching copyable `POST /context` curl.
  - **`[[Title]]` selector + hop-expansion hardening** (`src/nodes/query-routes.ts`) — a pure `[[Title]]` selector sent alongside `prompt` no longer gets silently overwritten; hop expansion now checks document status so drafts can't leak in via a neighbor 1+ hops from a matched title when `include_drafts` is off; id-style `[[nodes/some-id]]` wikilinks resolve in hop adjacency the same way the graph builder does.

  ### Accounts & auth

  - **`POST /auth/invite` issues a temporary password, not an API key** (`src/auth/routes.ts`, `ui/src/components/TeammatesPage.tsx`) — invited teammates previously got an unusable placeholder password and could never log in with email + password. Re-inviting an unclaimed user now refreshes the temp password; an already-claimed user gets `409` (use Reset password) so a real login can't be clobbered.
  - Login normalizes email via trim + lowercase, so autofill whitespace no longer 401s. Admin password reset no longer revokes the user's API key (independent credentials); sessions are still cleared.
  - **Auth invite flow ported to the async DB adapter** (`src/annotations/service.ts`, `src/auth/routes.ts`) so it works against Postgres, not just SQLite.
  - **Migration 012 — merge case-colliding user rows** (`src/db/migrations.ts`, `src/db/migrations.postgres.ts`) — pre-existing `Bob@x.com`/`bob@x.com` collisions (left behind by migration 009's NOCASE-unique constraint) resolved to different rows, so password resets and logins targeted the wrong account. The migration merges each case-insensitive email group into one winner and repoints every FK and email-keyed reference, then canonicalizes emails to lowercase. A follow-up fix corrected the steward dedup, whose correlated `EXISTS` self-matched every row in a collision group and deleted _all_ active steward grants for the email instead of collapsing duplicates — a governance regression hidden inside the login fix.

  ### Nest dashboard

  - **`GET /nests` tile metadata actually works** (`src/nests/routes.ts`) — was 500ing (`db.prepare` doesn't exist on the async DB adapter) and, once fixed, always reported 0 documents (missing `await` on `engineCache.get()`). Per-nest filesystem scans replaced with grouped queries over `node_versions`/`nest_collaborators`/`stewards`, so `Dashboard.tsx` nest tiles show accurate document/collaborator/steward counts with no per-load fs I/O.

  ### Tests

  New/expanded coverage: `test/annotations.test.ts`, `test/context-endpoint.test.ts`, `test/db-postgres.test.ts`, `test/delegated-admins.test.ts`, `test/invite.test.ts`, `test/key-mode.test.ts`, `test/mcp-routes.test.ts`, `test/merge-colliding-users.test.ts`, `test/nest-tile-metadata.test.ts`, `test/nested-folders.test.ts`.

## 1.6.0

### Minor Changes

- v1.6.0 — configurable nest storage and a PostgreSQL/Cloud SQL backend for durable Cloud Run deployments.

  ### Storage

  - **Configurable `NEST_STORAGE_ROOT`** — nest vault files (markdown + version history) can now live outside `DATA_ROOT`, e.g. on a GCS volume mount on Cloud Run, while the DB stays on `DATA_ROOT`. Path resolution is centralised so the root is set in one place (`src/config.ts`, `src/shared/paths.ts`, `src/nests/service.ts`). Defaults to `<DATA_ROOT>/nests`, so existing deployments are unchanged.

  ### Database

  - **PostgreSQL / Cloud SQL backend** — an async DB adapter lets the server run on PostgreSQL alongside the existing SQLite backend, with Cloud SQL Auth Proxy (unix socket) and TCP+TLS connection support for durable Cloud Run deployments (`src/db/adapter.ts`, `src/db/adapter.postgres.ts`, `src/db/adapter.sqlite.ts`, `src/db/migrations.postgres.ts`, `src/db/sql.ts`, `src/db/client.ts`). New `DB_*` env vars: `DB_DRIVER`, `DATABASE_URL`, `CLOUD_SQL_CONNECTION_NAME`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_POOL_MAX`, `DB_SSL`, `DB_SSL_CA`. SQLite stays the default when no connection is configured, so existing deployments keep working untouched (`CONFIGURATION.md`, `.env.example`).

  ### Fixes

  - **Security** — the admin guard on `/admin/settings` is now correctly awaited, closing a window where the async check did not gate the request (`src/app.ts`).
  - **AdminLoginModal** — now respects `PROMPTOWL_SIGN_IN_GATE` (`ui/src/components/AdminLoginModal.tsx`).
  - **Drift scanner toggle** — `DRIFT_SCAN_INTERVAL_MS=0` now disables the drift scanner (`src/index.ts`).
  - **Nest-root seam** — the unsynced-service no longer risks deleting live nests when `NEST_STORAGE_ROOT` is nested under `DATA_ROOT` (`src/nests/unsynced-service.ts`, `src/nests/service.ts`).

## 1.5.0

### Minor Changes

- v1.5.0 — AI-assisted context authoring, drag-and-drop ingestion, editor power tools, and a dedicated Server settings page.

  ### Authoring & AI

  - **"Add with AI"** — generate structured context from a prompt and push it straight into the nest; the assistant interviews and organizes the material rather than dumping raw text (`ui/src/components/GenerateContextModal.tsx`, `ui/src/components/NestView.tsx`, `ui/src/lib/api.ts`).
  - **Drag-and-drop file ingestion** — drop files directly onto a vault to import them, with a discoverable import button and an empty-state drop zone (`ui/src/components/NestView.tsx`).

  ### Document editor

  - **Raw markdown toggle** — switch the document editor between rich and raw markdown views (`ui/src/components/DocumentEditor.tsx`).
  - **Inline version diff** — view a highlighted diff against a prior version from inside the editor, with an unsaved-changes indicator and diff reset (`ui/src/components/DocumentEditor.tsx`, `ui/src/components/governance/VersionHistory.tsx`).
  - **HTML artifact markers** — documents containing HTML artifacts are flagged in both the document list and the recently-edited views (`ui/src/components/NestView.tsx`).

  ### Server settings

  - **Dedicated Server settings page** with admin controls for logo, telemetry, base URL, and upload size limit, backed by new `/admin/settings` GET/PATCH endpoints (`ui/src/components/SettingsPage.tsx`, `src/app.ts`, `ui/src/lib/api.ts`).
  - **Admin sign-in gate toggle** — admins can set the PromptOwl sign-in gate (`open` / `admin-only` / `disabled`) from the user menu (`ui/src/App.tsx`, `ui/src/lib/api.ts`).

  ### Fixes

  - `/admin/settings` PATCH is now atomic, with test coverage (`src/app.ts`, `test/admin-settings.test.ts`).
  - Whitespace-only passwords are rejected at registration/login (`src/auth/routes.ts`, `test/password-validation.test.ts`).
  - The document list reappears after clearing a no-result search in the Link-to-Document modal (`ui/src/components/DocumentPickerModal.tsx`).

## 1.4.0

### Minor Changes

- v1.4.0 — collaboration, hosted artifacts, ontology graph, and one-click SSO.

  ### Collaboration & sharing

  - **Standalone collaboration comments + activity log** — contributors can comment on documents independent of the review workflow, and a per-nest activity log records governance events (`src/governance/comment-service.ts`, `CommentsPanel.tsx`).
  - **Granular share permissions** — collaborator invites are now escalation-capped instead of admin-only, so an editor can invite another collaborator without exceeding their own permission tier (`src/nests/sharing-service.ts`).
  - **Shareable document URLs** — documents now have stable deep-link URLs that open the target document directly.

  ### Hosted artifacts & annotations

  - **Hosted artifacts + threaded annotations** — non-markdown artifacts can be hosted and viewed in-app, with threaded annotations anchored to artifact text (`src/annotations/*`, `ArtifactViewer.tsx`, `ui/src/lib/artifact-text.ts`).

  ### Ontology graph

  - **Ontology graph view** — an interactive canvas of nodes, `[[wikilinks]]`, and stewardship overlay that surfaces coverage gaps. Supports pan, zoom, and fit-to-view; steward emails are masked for the read tier and the drawn-node count is capped for large graphs (`src/nodes/graph-service.ts`, `OntologyGraphView.tsx`).

  ### Auth

  - **One-click SSO auto-login** — users can sign into ContextNest Community directly from PromptOwl via a short-lived SSO token (`src/auth/sso-token.ts`, `test/sso-route.test.ts`, `test/sso-token.test.ts`).

  ### Fixes

  - Hyperlink / wiki-link navigation now resolves to the configured target.
  - Comment and annotation projection conflict resolved.
  - Editors can add new collaborators in the UI.

## 1.3.0

### Minor Changes

- v1.3.0 — server super-admins, license-persistence hardening, document history pass, and internal-folder sync.

  ### Governance & access

  - **Server super-admins** (`access.yaml: super_admins`) now administer every nest — change visibility, manage collaborators, manage stewards — without being added per-nest. Owner-only operations (delete, transfer) still require the owner. Surfaced server-side in `src/governance/stewardship-service.ts`, `src/shared/access.ts`, and the nest routes.
  - **Public/private visibility toggle** is now on the nest header itself, not buried in a dialog. Reads as the source of truth for who can see the nest.
  - **Review queue surfaces submitted-for-review edits** so reviewers see the pending versions a contributor staged, not just net-new documents.

  ### License & onboarding

  - **`PROMPTOWL_KEY` now persists under `$DATA_ROOT/.env`** (was: `$cwd/.env`, which is root-owned `/app` in the official image and silently lost the key on container recreate). Surfaces write failures on the License Setup Page instead of failing silently. Override via `ENV_FILE_PATH`.
  - **Case-insensitive email** across registration, login, invite, and access checks — dedupes existing accounts on migration, fixes "I can't log in because I capitalized my email", and unblocks access-guard / lockout mismatches.

  ### Document workflow

  - **Version history + highlighted diffs** in the document detail view — every saved version is browsable, and an inline diff highlights what changed between any two versions.
  - **Nest Overview / index landing** — a grouped table-of-contents plus a "recently edited" strip lands every nest on a navigable index instead of a flat list.
  - **Hyperlink navigation fix** — hyperlinks in the editor / viewer now navigate to their configured target URL correctly.

  ### MCP & telemetry

  - **Internal-folder sync** (`src/nests/unsynced-service.ts`, new MCP tools): an external client can list the unsynced folders under a nest's filesystem vault and pull them into the nest on demand. Covered by `test/unsynced-folder.test.ts` and `test/mcp-unsynced.test.ts`.
  - **Telemetry batch_id + user email**: usage events now carry a stable `batch_id` (de-duped on the receiver) and the authenticated user email alongside the user id, so the `TheOwl` ingest bridge can meter credits to the right account.

  ### Repo / DX

  - **`CLAUDE.md`** added at the repo root with project-specific guidance for Claude Code (engine-boundary rule, command index, architecture map, key patterns).
  - **GitHub Actions** — `claude.yml` (PR assistant) and `claude-code-review.yml` (auto review on PRs) workflows shipped.

## 1.2.0

### Minor Changes

- bcd9fdf: Community usability + editor pass.

  Admin & auth (in-platform — no email server):

  - **Admin password reset** (`POST /auth/admin/reset-password/:userId`): set a user's password or generate a temporary one returned once for the admin to share; revokes the user's API keys + sessions. A self-service **Change password** action was added to the user menu so the recipient can set their own.
  - **Remove users** (`DELETE /auth/users/:userId`): revokes api keys, sessions, steward + collaborator rows, then deletes the account. Blocks self-delete and users who still own nests.
  - **`PROMPTOWL_SIGN_IN_GATE`** (`open` / `admin-only` / `disabled`): restrict "Sign in with PromptOwl" to the admin; everyone else uses email/password. Enforced server-side; the admin reaches it via `?admin=1`.

  Agents & governance:

  - **Plain-text view for agents** — `?format=markdown` on a node returns frontmatter + body as `text/markdown`.
  - **Steward version revert** (`POST .../revert`) restores an earlier version as a new one; a pending-review document is now editable (saving withdraws the review, matching server behavior).

  Editor: always-editable surface, selection bubble toolbar, turn-into, in-doc find & replace, wiki/code-safety fixes, and rich blocks (tables, callouts, toggles, syntax-highlighted code, columns).

- 73a022c: Wiki usability pass — the nest reads like a real wiki.

  - **Backlinks**: every document shows "Linked from N documents" (client-side reverse index over `[[wiki links]]`; zero server changes).
  - **Outline/TOC**: docs with 3+ headings get a clickable outline that scrolls to the section.
  - **Hover-preview**: hovering a `[[wiki link]]` in the read view shows the target's title + snippet, resolved from the already-loaded list.
  - **Multi-tag filtering**: tag chips on document rows are clickable and combine into an AND filter with a clear bar.
  - **Sharing clarity**: the document view's share button now says "Share nest" and the dialog states sharing applies to the whole nest (stewards restrict individual docs). New "Copy link" button produces a `?nest=&doc=` deep link, and the app's deep-link probe opens documents directly.
  - **Rename safety**: retitling a doc warns which `[[Title]]`-form links would break (slug links survive).
  - **Link health**: the document list reports broken links and orphan docs, each clickable.
  - **Recently edited**: a quick-access strip appears once a nest outgrows a glance (5+ docs).

### Patch Changes

- Post-changeset bug fixes rolled into v1.2.0.

  - **Editor toolbar overflow** — top content toolbar no longer overflows on narrow widths; bubble toolbar (selection format-on-highlight) is no longer obscured by the top toolbar on first/top blocks.
  - **Drag handle** — black dropcursor line no longer lingers briefly after release.
  - **Wiki links** — visible visual styling beyond underline (color + hover state); hover preview now triggers reliably; internal navigation path cleaned up.
  - **Change password modal** — UX polish; password change flow now blocks reuse of the current password.

## 1.1.0

### Minor Changes

- v1.1.0 — sharing, vault import, and governance release. Adds the ability to bring existing markdown into a nest, share nests with collaborators or the public, and brand the UI, alongside a governance and editor pass.

  ### Vault import

  - **Import an existing folder / vault** (`src/fs/vault-import.ts`, `ui/src/components/ImportFolderModal.tsx`): create a new nest from a folder of markdown files in one step — from the dashboard ("Import folder") or via the API. Frontmatter, `[[wiki links]]`, and folder structure are preserved. Covered by `test/import-nest.test.ts`.

  ### Sharing & visibility

  - **Per-nest sharing + collaborators** (`src/nests/sharing-service.ts`, `sharing-routes.ts`, `ui/src/components/ShareNestDialog.tsx`, `CollaboratorManager.tsx`): set a nest's visibility and add collaborators with read or write access. A Share affordance is now inline in the document view.
  - **Public read-only nests** (`visibility=public`): flip a nest to public to serve it to unauthenticated readers. The bypass applies to GETs only — write actions still require a valid key.

  ### Governance & stewardship

  - **Owner self-approve** — a nest owner can approve their own changes, replacing the previous per-nest toggle.
  - **Auto-approve toggle** — new per-nest option to auto-approve incoming changes.
  - **Role-based action gating** — UI buttons and actions now reflect the viewer's role; non-permitted actions are hidden rather than failing on submit.
  - **Steward scope editing** — stewards can edit scope during a role change; fixes the case where a steward role update did not allow scope modification.
  - **Stewardship service overhaul** (`src/governance/stewardship-service.ts`, `roles.ts`, `title-resolver.ts`): consolidated role handling, manage-own-record restriction, and a shared title resolver.
  - **MCP tools control logic** (`src/mcp/tools.ts`): reworked collaborator access actions and tool exposure to match the new permission model.

  ### Editor & UI

  - **Wiki linking** — `[[wikilink]]` autocomplete; clicking a broken link creates a new doc with the title pre-filled; tag chips filter the nest list.
  - **Document view** — Notion-style H1 title, click-to-edit, breadcrumb back navigation, and an unsaved-changes warning.
  - **Custom logo / branding** (`LOGO_URL`) — show your own logo in the UI header and login screen; invalid schemes fall back to the bundled icon.
  - **Error boundary** (`ui/src/components/ErrorBoundary.tsx`) — a render error in one view no longer blanks the whole app.

  ### Auth & fixes

  - Auth / license refactor (`src/auth/license.ts`, `routes.ts`, `keys.ts`) and login-flow fixes for external editors and public readers.
  - Review queue card now binds to the reviewable count instead of the raw queue.
  - Rate-limit, access-guard, and key-mode handling hardened; covered by expanded `test/governance.test.ts`, `security.test.ts`, and new `key-mode.test.ts`.
  - Bumped `uuid` to 14; added `@tailwindcss/typography`.

  ### Docs

  - README: new "What's new in 1.1.0", import / sharing / public-read / branding in the feature table.
  - CONFIGURATION.md: documented `LOGO_URL`.
  - `.env.example`: corrected `AUTH_MODE` default to `key`.

## 1.0.1

### Patch Changes

- 9d8d45a: v1.0.1 — bug-fix and polish release. Pulls in the new `@promptowl/contextnest-engine` document-hashing pipeline (external-edit detection, safe-publish, version diff), and clears a backlog of auth, license, governance, and UI issues found while dogfooding v1.0.0.

  ### Engine integration — document hashing

  Updated `@promptowl/contextnest-engine` integration to use the engine's content-hashing pipeline for change detection, conflict-aware saves, and AI-readable publish gating:

  - **External-edit detection** (`src/governance/external-edit-service.ts`, `ui/src/components/governance/ExternalEditBanner.tsx`): server compares the stored content hash against the on-disk hash on every read; when they diverge (file edited outside the UI), the editor shows an "External edit detected" banner with a side-by-side diff and a single-click "Adopt external edit" / "Keep my version" choice.
  - **Safe-publish** (`src/governance/safe-publish.ts`): publish actions now hash the candidate content and refuse to overwrite a newer base version. Replaces the previous "last-write-wins" path.
  - **Version diff** (`ui/src/components/governance/DiffViewer.tsx`, `VersionHistory.tsx`): version-history rows now render an inline diff against the previous hash.
  - **Lifecycle badge** (`LifecycleStatusBadge.tsx`): doc list/header surfaces the live lifecycle state (draft / under review / approved / external-edit) driven by engine hashes.
  - New backfill (`src/db/backfill.ts`) computes hashes for pre-existing documents on first boot of v1.0.1 — no manual migration required.

  ### Authentication & sessions

  - **Session not invalidated across tabs after logout** — `AuthContext` now broadcasts logout via `storage` events; every open tab clears its session immediately instead of holding a stale user object until the next refresh.
  - **PromptOwl login stuck on "Waiting for approval" after denial** — `Login.tsx` / `AdminLoginModal.tsx` now consume the denial response, surface a clear error, and reset the polling state so the user can retry without reloading.
  - **Login screen — password field missing show/hide (eye) icon** — added password-visibility toggle to the login form.
  - **Logout has no confirmation or success feedback** — added confirm dialog before logout and toast on success.

  ### License

  - **License revocation does not immediately block write actions** (`src/auth/license.ts`, `src/index.ts`) — the long-poll watcher now flips an in-process "writes blocked" flag synchronously on revoke, so the next non-GET request returns `503` instead of completing against a revoked license.
  - **Removed `PROMPTOWL_DEV_LICENSE_BYPASS` env var** — the bypass was added as a test-helper escape hatch, then leaked into production code paths. Tests now mint a real test license via `test/helpers.ts`; the bypass is gone from `src/config.ts` and `src/app.ts`.

  ### Governance & stewardship

  - **Manage delete event + user-role permission** — extracted nest-delete into a dedicated `DeleteNestDialog`, wired it through `App.tsx` / `Dashboard.tsx` / `NestView.tsx`, and tightened the steward / collaborator permission check in `src/nests/service.ts` so non-owners can no longer trigger destructive operations from a stale UI state.
  - **Removed folder-scope and approve/reject checkboxes from steward assignment** — the matrix UI implied per-action permissions that the server never enforced. Simplified `StewardAssignmentModal` / `StewardList` to role-only assignment; updated `API.md` and `STEWARDSHIP.md` to match.
  - **Document status management** — fixed `review-service.ts` so a doc moves to `approved` (not stuck in `under_review`) when stewardship is toggled off mid-flight; `NestView` re-fetches the lifecycle badge after the transition.

  ### UI / editor

  - **Render markdown nodes properly (`DocumentViewer` + view/edit toggle)** — new `DocumentViewer` component (react-markdown + remark-gfm + a small wikilink plugin) renders CLI/MCP-authored markdown correctly. Existing docs open in view mode; new docs in edit mode; toolbar toggles between them. Resolves "the nest should render markdown properly, and handle wiki cross-linking, today it does not."
  - **Correct edit and view mode** — fixed `DocumentEditor` so the view/edit toggle preserves unsaved changes and reflects the active mode in the toolbar.
  - **`MarkdownEditor.setContent` — pass `SetContentOptions` object** — adapted to TipTap v3 API; clears a console warning and a subtle cursor-jump bug.
  - **Clarify "publish" semantics in document editor + stewardship copy** — "Submit for Review" → "Publish (requires approval)" when stewardship is on; "Auto-published" badge when off; modal + settings help text aligned. Wording-only, no behaviour change.
  - **Connect modal — API-key rotation warning persists after rotation** — the stale warning is now cleared the moment the rotation succeeds.
  - **"Claim as Admin" button visible in OPEN mode** — hidden in open mode where the concept doesn't apply.
  - **Dashboard summary card now shows nests / documents / users** — new top-level `GET /stats` endpoint (`src/app.ts`) returns counts scoped to the caller's visible nests; dashboard renders three tiles instead of one, with `"—"` fallback when `/stats` is unavailable (older server / license gate).
  - **`NestSettingsModal` — Danger Zone (type-to-confirm delete)** — initial UI affordance for the already-existing `DELETE /nests/:nestId` route; superseded later in this release by the extracted `DeleteNestDialog`.
  - **Improvement — model list scroll + nest version display** — model picker is now scrollable on long lists; nest header shows the correct engine/community version pair.

  ### Docker / build

  - **Dockerfile: use npm to match shipped lockfile + bump to `node:22`** — the previous Dockerfile copied a non-existent `pnpm-lock.yaml`, breaking `docker build` immediately. Install now goes through npm against the shipped `package-lock.json`. Base image bumped to `node:22-slim` because the build script's pnpm step requires Node ≥ 22.
  - **`package-lock.json`** updated to reflect the engine and dev-dep changes; verified `npm ci` clean.

  ### Tests / infra

  - **Fix 14 broken integration tests on `main` (license + helpers)** — three stacked causes (license-gate 503s on every non-GET, `/auth/register` no longer returns `api_key`, `POST /auth/keys` now `409`s on duplicate). Helpers register and mint via `/auth/keys` explicitly; key-mode assertions realigned. Result: open-mode 13/13, key-mode 12/12, full community suite 118/118 passing.
  - **Fix governance test case** — corrected stale fixture data after the status-management fix above.

  ### CI / release

  - Added `Release` GitHub Actions workflow + Changesets configuration. (Auto-publish disabled until `NPM_TOKEN` is provisioned; this release was cut by `npm publish` locally.)

## 1.0.0

### Major Changes

- 032c7d2: v1.0.0 — first stable release of ContextNest Community Edition.

  **License & setup**

  - New **License Setup Page**: server boots into setup mode when no PromptOwl license is installed. Operator pastes a `pk_...` key in the browser; the server validates against PromptOwl, persists it to `.env`, and exits setup mode. Reads stay available while unlicensed; writes return `503` until activation.
  - **Live license revocation**: long-poll watcher against `app.promptowl.ai/api/license/listen` flips the server back into setup mode within seconds of a revoke — no restart required.
  - **Admin identity derived from license**: the admin user is whichever PromptOwl account owns the currently-installed license, resolved live per request. Transferring the license to a new account immediately promotes the new owner and demotes the old one (replaces the previous static `users.is_admin` flag).

  **Auth**

  - **Cookie-based web sessions**: browser auth now uses an `httpOnly` session cookie set on `/auth/register`, `/auth/login`, and `/auth/promptowl`, and cleared on logout. Replaces the previous localStorage-token flow. CLI / Claude Desktop / MCP clients continue to use Bearer API keys — unchanged.
  - **Invited-user claim flow**: emails added via nest-share or steward-assignment create a placeholder user row (`is_invited = 1`). When that email later registers, the existing row is claimed in place, so all pre-assigned nests and stewardship roles carry over.
  - New `AuthContext` provider on the frontend with stale-fetch protection so rapid login/logout cycles cannot clobber state.

  **Editor**

  - New **Document Editor** page (TipTap markdown) replacing the old textarea. Adds:
    - Tags and conflict-aware save (`409` with rejected content preserved when base version is stale).
    - Internal wiki links via `[[` and a Document Picker modal, rendered as `nest://...` references.
    - Mentions and interactive task checkboxes.
    - In-editor governance actions (Submit for Review / Approve / Reject) when stewardship is enabled on the nest.

  **Governance**

  - **Steward = collaborator**: assigning a steward now also creates the matching `nest_collaborators` row so the assigned user can see the nest in their dashboard. Editors get `write`, reviewers/viewers get `read`.
  - Fixed folder-scope steward resolution so a folder pattern at the nest root matches the document at that exact path, not only nested sub-paths.

  **API & docs**

  - New top-level `API.md` (~520 lines) documenting the full REST surface, request/response shapes, and error codes.
  - Clearer error messages across auth, license, and conflict responses.

  **Internal**

  - Switched build script from `pnpm` to `npm` to align with the package-lock-based toolchain.
  - Added `@changesets/cli` + `@changesets/changelog-github` and the `Release` GitHub Actions workflow for npm publishing.
