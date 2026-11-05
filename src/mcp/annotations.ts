/**
 * What every MCP tool is called and does to the world, in one table: the single
 * source of each tool's `title` and `annotations` in tools/list on /mcp and
 * /nests/:id/mcp. Clients use the hints to warn before a call, and OpenAI's app
 * review reads them.
 *
 * Classify from the handler's real effect, not the tool's name:
 *  - readOnlyHint: nothing in the nest or on the server changes. Audit rows
 *    (the activity trace, the access log) and caches don't count as changes.
 *  - destructiveHint: it can overwrite or remove something that already exists,
 *    even when a version history keeps the earlier text.
 *  - openWorldHint: it can reach beyond the caller's authorised nests: arbitrary
 *    URLs or email addresses, the public internet, or a third-party workspace.
 *    Notifying a nest's own members or its configured connectors doesn't count.
 *
 * A new tool needs a row here: test/mcp-annotations.test.ts fails without one,
 * and on a stale row. `why` is for reviewers; it never reaches clients.
 */
export interface ToolClassification {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
  /** What a person sees: 2-4 plain words. */
  title: string;
  why: string;
}

const read = (title: string, why: string): ToolClassification => ({ readOnlyHint: true, destructiveHint: false, openWorldHint: false, title, why });
/** Reads, but from outside the nest. */
const readOutside = (title: string, why: string): ToolClassification => ({ readOnlyHint: true, destructiveHint: false, openWorldHint: true, title, why });
/** Writes that only add. */
const add = (title: string, why: string): ToolClassification => ({ readOnlyHint: false, destructiveHint: false, openWorldHint: false, title, why });
const addOutside = (title: string, why: string): ToolClassification => ({ readOnlyHint: false, destructiveHint: false, openWorldHint: true, title, why });
/** Writes that can overwrite or remove. */
const overwrite = (title: string, why: string): ToolClassification => ({ readOnlyHint: false, destructiveHint: true, openWorldHint: false, title, why });
const overwriteOutside = (title: string, why: string): ToolClassification => ({ readOnlyHint: false, destructiveHint: true, openWorldHint: true, title, why });

export const TOOL_CLASSIFICATION: Record<string, ToolClassification> = {
  // ─── Server level ───────────────────────────────────────────────────────
  nest_index: read("List nests", "Lists the nests these credentials can read."),
  nest_create: add("Create nest", "Creates a new, empty nest; a taken name gets a suffix, never an overwrite."),

  // ─── Reading a nest ─────────────────────────────────────────────────────
  context_init: read("Load nest instructions", "Returns CONTEXT.md and the always-include documents."),
  context_instructions_history: read("View instructions history", "Returns past revisions of CONTEXT.md."),
  context_overview: read("Get nest overview", "Returns counts and a listing of what the caller can see."),
  context_search: read("Search documents", "Full-text search over documents the caller can read."),
  context_query: read("Run selector query", "Runs a selector over the nest's graph."),
  context_table_query: read("Query table rows", "Returns rows from a table node."),
  context_get: read("Read document", "Returns one document."),
  context_list: read("List documents", "Lists documents."),
  context_resolve: read("Fetch matching documents", "Resolves a selector to documents and their bodies."),
  context_export: read("Export whole nest", "Returns the readable documents as one text; it sends nothing anywhere."),
  context_comments: read("Read comments", "Returns a document's comment threads."),
  context_relations: read("List task relations", "Returns a task's relations."),
  context_boards: read("List boards", "Lists saved boards."),
  context_board_items: read("List board items", "Returns a board's items."),
  context_fields: read("List custom fields", "Lists custom field definitions."),
  context_stewards: read("Show stewards", "Returns who reviews a document, or the nest's roster."),
  context_deletion_queue: read("View deletion requests", "Lists pending deletion requests."),
  context_access_requests: read("View access requests", "Lists pending access requests."),
  context_review_queue: read("View review queue", "Lists review requests."),
  context_my_drafts: read("View my drafts", "Lists the caller's unsubmitted drafts."),
  context_versions: read("View version history", "Returns a document's version history."),
  context_unsynced_list: read("List unsynced folders", "Lists server folders not yet synced to a nest."),

  // ─── Documents ──────────────────────────────────────────────────────────
  context_create: add("Create document", "Creates a node; a title or path already in use is refused."),
  context_upload: overwriteOutside("Upload file", "Downloads from any public https URL; node_id replaces an Office document's file with a new version."),
  context_update: overwrite("Update document", "Replaces content, tags and fields of an existing node."),
  context_bulk_update: overwrite("Update many documents", "Changes tags, fields and columns on up to 100 existing nodes."),
  context_delete: overwrite("Delete documents", "Deletes nodes with their history, irreversibly."),
  context_archive: add("Archive document", "Takes a node out of lists and retrieval; nothing is deleted and context_unarchive restores it."),
  context_unarchive: add("Unarchive document", "Brings an archived node back in the status it left."),
  context_move: add("Move document or folder", "Refiles a node or folder; an occupied destination is refused, history follows, and it can be moved back."),
  context_table_rows: overwrite("Change table rows", "Updates and deletes rows of a table node."),
  context_instructions_update: overwrite("Replace nest instructions", "Replaces the whole of CONTEXT.md."),
  context_task_log: add("Log task activity", "Appends to a task's log; claiming only takes an unassigned task."),

  // ─── Comments and relations ─────────────────────────────────────────────
  context_comment: add("Add comment", "Adds a comment; it never edits an existing one. Notifies nest members."),
  context_resolve_comment: add("Resolve comment thread", "Flips a thread between open and resolved; the thread is kept and can be reopened."),
  context_add_relation: add("Add task relation", "Adds a relation; duplicates are refused."),
  context_remove_relation: overwrite("Remove task relation", "Removes a relation."),

  // ─── Custom fields ──────────────────────────────────────────────────────
  context_create_field: add("Create custom field", "Adds a field definition."),
  context_update_field: overwrite("Update custom field", "Changes an existing field definition."),
  context_delete_field: overwrite("Delete custom field", "Removes a field definition."),

  // ─── Governance ─────────────────────────────────────────────────────────
  context_request_deletion: add("Request deletion", "Files a request; nothing is deleted."),
  context_resolve_deletion: overwrite("Decide deletion request", "Honouring a request deletes a document or folder, or deletes or archives the nest."),
  context_request_access: add("Request write access", "Files a request; the nest's admins are notified."),
  context_resolve_access_request: add("Decide access request", "Adds access or raises a role; nobody loses anything, unlike context_grant, which can lower one."),
  context_submit_review: add("Submit for review", "Opens a review request on an existing version; content is unchanged."),
  context_approve: overwrite("Approve document", "Publishes the version, replacing the text served to AI."),
  context_reject: add("Reject document", "Marks the version rejected; the published text and the draft stay."),
  context_assign_steward: addOutside("Assign steward", "Adds a steward and turns on governed mode; an unknown email address is emailed an invitation. An existing assignment is refused, not replaced."),
  context_share_nest: addOutside("Share nest", "Adds a collaborator; an unknown email address is emailed an invitation. An existing collaborator is refused, not changed."),
  context_grant: overwriteOutside("Share document or folder", "Shares a document or folder; an unknown email address is emailed an invitation, and an existing grant's role is overwritten."),
  context_sync_folder: overwrite("Import server folder", "Imports a server folder into a new nest, then deletes the source folder from disk."),

  // ─── Nest administration ────────────────────────────────────────────────
  context_headless: overwrite("Manage headless publishing", "Dispatches status, enable, disable, create_key and revoke_key; disabling pauses and revoking removes keys. The token goes only to the caller."),
  context_set_visibility: overwriteOutside("Set nest visibility", "Replaces who can read the nest, up to anyone on the internet."),
  context_systems: overwrite("Manage system identities", "Dispatches list, create, rotate, revoke, add_nest and remove_nest; rotating and revoking kill keys. The token goes only to the caller."),

  // ─── Metacognition agents ───────────────────────────────────────────────
  context_metacognition_list: read("List metacognition agents", "Lists configured agents and agent documents."),
  context_metacognition_suggest: read("Suggest agent settings", "Derives a config from the agent document; it saves nothing and fetches nothing, feed links included."),
  context_metacognition_preview: read("Preview agent settings", "Validates a config and summarizes it; it saves nothing and fetches nothing."),
  context_metacognition_configure: overwriteOutside("Save agent settings", "Replaces an agent's stored settings and points it at arbitrary public feeds and MCP servers, which its schedules and hooks then reach."),
  context_metacognition_run: overwriteOutside("Run agent now", "Starts one run that may fetch the agent's feeds, call its MCP servers and the model; its drafts replace working copies, and it withdraws its own rejected drafts, deleting any never published."),
  context_metacognition_remove: overwrite("Remove metacognition agent", "Removes an agent's settings; the document and past runs stay."),

  // ─── Workflow plane ─────────────────────────────────────────────────────
  workflow_run: add("Start workflow run", "Records a new run and returns the bundle; the caller does the executing."),
  workflow_run_step: add("Record run step", "Appends a step to an open run."),
  workflow_run_close: overwrite("Close workflow run", "Closes a run; a trace sent here replaces the stored one."),
  workflow_run_get: read("View workflow run", "Returns one run's trace."),
  workflow_runs_list: read("List workflow runs", "Lists runs, or an agent's stats."),
  workflow_edges_list: read("List workflow edges", "Lists edges."),
  workflow_edge_create: add("Create workflow edge", "Adds an edge; duplicates and cycles are refused."),
  workflow_edge_delete: overwrite("Delete workflow edge", "Deletes an edge."),
  workflow_edge_types_list: add("List edge types", "Lists edge types, and writes the five stock types the first time a nest asks."),
  workflow_edge_type_upsert: overwrite("Save edge type", "Overwrites an edge type of the same name."),
  workflow_edge_type_delete: overwrite("Delete edge type", "Deletes an edge type."),

  // ─── Surfaces: reads ────────────────────────────────────────────────────
  context_surfaces_status: read("Show Surfaces status", "Counts bindings from the server's own tables."),
  context_surfaces_bindings_list: read("List conversation bindings", "Lists bindings from the server's own tables."),
  context_surfaces_binding_preview: readOutside("Preview conversation binding", "Saves nothing, but asks the third-party workspace for the conversation's members."),
  context_surfaces_links_list: read("List identity links", "Lists identity links."),
  context_surfaces_link_reviews_list: read("List link reviews", "Lists pending link reviews."),
  context_surfaces_settings_get: read("View Surfaces settings", "Returns the Surfaces settings."),
  context_surfaces_windows_list: read("View judgement log", "Returns the verdict log."),
  context_surfaces_proposals_list: read("List Surfaces proposals", "Lists proposals."),
  context_surfaces_my_pending: read("View my pending proposals", "Lists the caller's pending proposals."),
  context_surfaces_commits_list: read("View commit audit", "Returns the commit audit."),
  context_surfaces_budget_get: read("View Surfaces budget", "Returns the nest's spend budget."),
  context_surfaces_seed_list: read("List available seeds", "Lists available seeds."),
  context_surfaces_seed_status: read("View applied seeds", "Lists applied seeds."),

  // ─── Surfaces: writes ───────────────────────────────────────────────────
  context_surfaces_binding_create: addOutside("Bind conversation", "Binds a conversation: reads its members from the workspace and posts a notice there."),
  context_surfaces_binding_update: overwriteOutside("Update conversation binding", "Overwrites a binding's settings and re-runs the guard against the workspace, which can pause it and purge its buffer."),
  context_surfaces_binding_delete: overwriteOutside("Unbind conversation", "Unbinds: purges the buffer and withdraws pending cards in the workspace."),
  context_surfaces_binding_recheck: overwriteOutside("Recheck binding guard", "Re-reads members from the workspace; a failed guard pauses the binding and purges its buffer."),
  context_surfaces_binding_resume: addOutside("Resume conversation binding", "Resumes capture after re-reading members from the workspace."),
  context_surfaces_binding_invite: addOutside("Invite Nest back", "Brings Nest back to a conversation after checking its members in the workspace."),
  context_surfaces_link_revoke: overwriteOutside("Revoke identity link", "Revokes an identity link and can DM the linked owner in the workspace."),
  context_surfaces_link_unblock: overwrite("Unblock identity matching", "Clears a matching block, so auto-matching can link that user again; it removes no link and no content."),
  context_surfaces_link_review_decide: add("Decide link review", "Records the decision and creates the link on approval; an existing link is refused."),
  context_surfaces_slack_install_create: add("Start Slack install", "Creates a pending install and returns the manifest; it contacts nothing."),
  context_surfaces_settings_update: overwriteOutside("Update Surfaces settings", "Overwrites settings; turning DM capture off deletes DM buffers, and sign-in alert changes DM and email owners."),
  context_surfaces_budget_update: overwrite("Set Surfaces budget", "Overwrites the nest's spend cap."),
  context_surfaces_disconnect: overwriteOutside("Disconnect workspace", "Revokes the workspace token and deletes the install's secrets, bindings, buffers, drafts and links."),
  context_surfaces_seed_apply: overwriteOutside("Apply seed to nest", "With upgrade, overwrites untouched seeded documents; the org mirror reads members from the workspace."),
};

/** What a tool with no row gets. The guard test fails on such a tool, but one
 *  that reached production anyway must claim the most caution, not the least. */
const UNCLASSIFIED = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

/** A title for a tool with no row: its name, spaced out. */
function fallbackTitle(name: string): string {
  return name.replace(/^context_/, "").replace(/_/g, " ");
}

/** A tool's human title. */
export function toolTitle(name: string): string {
  return Object.hasOwn(TOOL_CLASSIFICATION, name) ? TOOL_CLASSIFICATION[name].title : fallbackTitle(name);
}

/** The annotations a tool carries in tools/list. */
export function toolAnnotations(name: string): { title: string; readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean } {
  const row = Object.hasOwn(TOOL_CLASSIFICATION, name) ? TOOL_CLASSIFICATION[name] : undefined;
  if (!row) return { title: toolTitle(name), ...UNCLASSIFIED };
  const { title, readOnlyHint, destructiveHint, openWorldHint } = row;
  return { title, readOnlyHint, destructiveHint, openWorldHint };
}
