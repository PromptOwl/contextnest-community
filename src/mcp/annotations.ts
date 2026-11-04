/**
 * What every MCP tool does to the world, in one table: the single source of
 * the `annotations` in tools/list on /mcp and /nests/:id/mcp. Clients use the
 * hints to warn before a call, and OpenAI's app review reads them.
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
  why: string;
}

const read = (why: string): ToolClassification => ({ readOnlyHint: true, destructiveHint: false, openWorldHint: false, why });
/** Reads, but from outside the nest. */
const readOutside = (why: string): ToolClassification => ({ readOnlyHint: true, destructiveHint: false, openWorldHint: true, why });
/** Writes that only add. */
const add = (why: string): ToolClassification => ({ readOnlyHint: false, destructiveHint: false, openWorldHint: false, why });
const addOutside = (why: string): ToolClassification => ({ readOnlyHint: false, destructiveHint: false, openWorldHint: true, why });
/** Writes that can overwrite or remove. */
const overwrite = (why: string): ToolClassification => ({ readOnlyHint: false, destructiveHint: true, openWorldHint: false, why });
const overwriteOutside = (why: string): ToolClassification => ({ readOnlyHint: false, destructiveHint: true, openWorldHint: true, why });

export const TOOL_CLASSIFICATION: Record<string, ToolClassification> = {
  // ─── Server level ───────────────────────────────────────────────────────
  nest_index: read("Lists the nests these credentials can read."),
  nest_create: add("Creates a new, empty nest; a taken name gets a suffix, never an overwrite."),

  // ─── Reading a nest ─────────────────────────────────────────────────────
  context_init: read("Returns CONTEXT.md and the always-include documents."),
  context_instructions_history: read("Returns past revisions of CONTEXT.md."),
  context_overview: read("Returns counts and a listing of what the caller can see."),
  context_search: read("Full-text search over documents the caller can read."),
  context_query: read("Runs a selector over the nest's graph."),
  context_table_query: read("Returns rows from a table node."),
  context_get: read("Returns one document."),
  context_list: read("Lists documents."),
  context_resolve: read("Resolves a selector to documents and their bodies."),
  context_export: read("Returns the readable documents as one text; it sends nothing anywhere."),
  context_comments: read("Returns a document's comment threads."),
  context_relations: read("Returns a task's relations."),
  context_boards: read("Lists saved boards."),
  context_board_items: read("Returns a board's items."),
  context_fields: read("Lists custom field definitions."),
  context_stewards: read("Returns who reviews a document, or the nest's roster."),
  context_deletion_queue: read("Lists pending deletion requests."),
  context_access_requests: read("Lists pending access requests."),
  context_review_queue: read("Lists review requests."),
  context_my_drafts: read("Lists the caller's unsubmitted drafts."),
  context_versions: read("Returns a document's version history."),
  context_unsynced_list: read("Lists server folders not yet synced to a nest."),

  // ─── Documents ──────────────────────────────────────────────────────────
  context_create: add("Creates a node; a title or path already in use is refused."),
  context_upload: overwriteOutside("Downloads from any public https URL; node_id replaces an Office document's file with a new version."),
  context_update: overwrite("Replaces content, tags and fields of an existing node."),
  context_bulk_update: overwrite("Changes tags, fields and columns on up to 100 existing nodes."),
  context_delete: overwrite("Deletes nodes with their history, irreversibly."),
  context_move: add("Refiles a node or folder; an occupied destination is refused, history follows, and it can be moved back."),
  context_table_rows: overwrite("Updates and deletes rows of a table node."),
  context_instructions_update: overwrite("Replaces the whole of CONTEXT.md."),
  context_task_log: add("Appends to a task's log; claiming only takes an unassigned task."),

  // ─── Comments and relations ─────────────────────────────────────────────
  context_comment: add("Adds a comment; it never edits an existing one. Notifies nest members."),
  context_resolve_comment: add("Flips a thread between open and resolved; the thread is kept and can be reopened."),
  context_add_relation: add("Adds a relation; duplicates are refused."),
  context_remove_relation: overwrite("Removes a relation."),

  // ─── Custom fields ──────────────────────────────────────────────────────
  context_create_field: add("Adds a field definition."),
  context_update_field: overwrite("Changes an existing field definition."),
  context_delete_field: overwrite("Removes a field definition."),

  // ─── Governance ─────────────────────────────────────────────────────────
  context_request_deletion: add("Files a request; nothing is deleted."),
  context_resolve_deletion: overwrite("Honouring a request deletes a document or folder, or deletes or archives the nest."),
  context_request_access: add("Files a request; the nest's admins are notified."),
  context_resolve_access_request: add("Grants what was asked for, only ever raising access; never lowers or removes it."),
  context_submit_review: add("Opens a review request on an existing version; content is unchanged."),
  context_approve: overwrite("Publishes the version, replacing the text served to AI."),
  context_reject: add("Marks the version rejected; the published text and the draft stay."),
  context_assign_steward: addOutside("Adds a steward; an unknown email address is emailed an invitation. An existing assignment is refused, not replaced."),
  context_share_nest: addOutside("Adds a collaborator; an unknown email address is emailed an invitation. An existing collaborator is refused, not changed."),
  context_grant: overwriteOutside("Shares a document or folder; an unknown email address is emailed an invitation, and an existing grant's role is overwritten."),
  context_sync_folder: overwrite("Imports a server folder into a new nest, then deletes the source folder from disk."),

  // ─── Nest administration ────────────────────────────────────────────────
  context_headless: overwrite("Dispatches status, enable, disable, create_key and revoke_key; disabling pauses and revoking removes keys. The token goes only to the caller."),
  context_set_visibility: overwriteOutside("Replaces who can read the nest, up to anyone on the internet."),
  context_systems: overwrite("Dispatches list, create, rotate, revoke, add_nest and remove_nest; rotating and revoking kill keys. The token goes only to the caller."),

  // ─── Metacognition agents ───────────────────────────────────────────────
  context_metacognition_list: read("Lists configured agents and agent documents."),
  context_metacognition_suggest: read("Derives a config from the agent document; it saves nothing and fetches nothing, feed links included."),
  context_metacognition_preview: read("Validates a config and summarizes it; it saves nothing and fetches nothing."),
  context_metacognition_configure: overwriteOutside("Replaces an agent's stored settings and points it at arbitrary public feeds and MCP servers, which its schedules and hooks then reach."),
  context_metacognition_run: addOutside("Starts one run that may fetch the agent's feeds, call its MCP servers and the model; its changes are drafts and comments, never published or deleted."),
  context_metacognition_remove: overwrite("Removes an agent's settings; the document and past runs stay."),

  // ─── Workflow plane ─────────────────────────────────────────────────────
  workflow_run: add("Records a new run and returns the bundle; the caller does the executing."),
  workflow_run_step: add("Appends a step to an open run."),
  workflow_run_close: overwrite("Closes a run; a trace sent here replaces the stored one."),
  workflow_run_get: read("Returns one run's trace."),
  workflow_runs_list: read("Lists runs, or an agent's stats."),
  workflow_edges_list: read("Lists edges."),
  workflow_edge_create: add("Adds an edge; duplicates and cycles are refused."),
  workflow_edge_delete: overwrite("Deletes an edge."),
  workflow_edge_types_list: add("Lists edge types, and writes the five stock types the first time a nest asks."),
  workflow_edge_type_upsert: overwrite("Overwrites an edge type of the same name."),
  workflow_edge_type_delete: overwrite("Deletes an edge type."),

  // ─── Surfaces: reads ────────────────────────────────────────────────────
  context_surfaces_status: read("Counts bindings from the server's own tables."),
  context_surfaces_bindings_list: read("Lists bindings from the server's own tables."),
  context_surfaces_binding_preview: readOutside("Saves nothing, but asks the third-party workspace for the conversation's members."),
  context_surfaces_links_list: read("Lists identity links."),
  context_surfaces_link_reviews_list: read("Lists pending link reviews."),
  context_surfaces_settings_get: read("Returns the Surfaces settings."),
  context_surfaces_windows_list: read("Returns the verdict log."),
  context_surfaces_proposals_list: read("Lists proposals."),
  context_surfaces_my_pending: read("Lists the caller's pending proposals."),
  context_surfaces_commits_list: read("Returns the commit audit."),
  context_surfaces_budget_get: read("Returns the nest's spend budget."),
  context_surfaces_seed_list: read("Lists available seeds."),
  context_surfaces_seed_status: read("Lists applied seeds."),

  // ─── Surfaces: writes ───────────────────────────────────────────────────
  context_surfaces_binding_create: addOutside("Binds a conversation: reads its members from the workspace and posts a notice there."),
  context_surfaces_binding_update: overwriteOutside("Overwrites a binding's settings and re-runs the guard against the workspace, which can pause it and purge its buffer."),
  context_surfaces_binding_delete: overwriteOutside("Unbinds: purges the buffer and withdraws pending cards in the workspace."),
  context_surfaces_binding_recheck: overwriteOutside("Re-reads members from the workspace; a failed guard pauses the binding and purges its buffer."),
  context_surfaces_binding_resume: addOutside("Resumes capture after re-reading members from the workspace."),
  context_surfaces_binding_invite: addOutside("Brings Nest back to a conversation after checking its members in the workspace."),
  context_surfaces_link_revoke: overwriteOutside("Revokes an identity link and can DM the linked owner in the workspace."),
  context_surfaces_link_unblock: add("Clears a matching block; it removes no link and no content."),
  context_surfaces_link_review_decide: add("Records the decision and creates the link on approval; an existing link is refused."),
  context_surfaces_slack_install_create: add("Creates a pending install and returns the manifest; it contacts nothing."),
  context_surfaces_settings_update: overwriteOutside("Overwrites settings; turning DM capture off deletes DM buffers, and sign-in alert changes DM and email owners."),
  context_surfaces_budget_update: overwrite("Overwrites the nest's spend cap."),
  context_surfaces_disconnect: overwriteOutside("Revokes the workspace token and deletes the install's secrets, bindings, buffers, drafts and links."),
  context_surfaces_seed_apply: overwriteOutside("With upgrade, overwrites untouched seeded documents; the org mirror reads members from the workspace."),
};

/** What a tool with no row gets. The guard test fails on such a tool, but one
 *  that reached production anyway must claim the most caution, not the least. */
const UNCLASSIFIED = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

/** The hints a tool carries in tools/list. */
export function toolAnnotations(name: string): { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean } {
  const row = Object.hasOwn(TOOL_CLASSIFICATION, name) ? TOOL_CLASSIFICATION[name] : undefined;
  if (!row) return { ...UNCLASSIFIED };
  const { readOnlyHint, destructiveHint, openWorldHint } = row;
  return { readOnlyHint, destructiveHint, openWorldHint };
}
