/**
 * `context_task_log` / POST …/task-log / `ctx task log` — one implementation
 * behind all three surfaces.
 *
 * Registers an interaction on a task (see task-activity.ts) and, with `claim`,
 * makes the caller the assignee when nobody is. Gated like an edit: logging is
 * a write, so a read-only collaborator, a viewer's key and a headless access
 * key are all refused.
 */
import * as stewardship from "../governance/stewardship-service.js";
import { ForbiddenError, NotFoundError } from "../shared/errors.js";
import type { ClientMetadata } from "../shared/client-metadata.js";
import { engineCache } from "./engine.js";
import { updateNode } from "./service.js";
import { settableTaskFields, taskFieldsOf } from "./task-fields.js";
import {
  parseTaskLogInput,
  recordTaskActivity,
  type TaskActivity,
} from "./task-activity.js";

export interface TaskLogResult {
  entry: TaskActivity;
  /** What `claim` did: assigned the caller, found them already assigned, or
   *  left someone else's assignment alone. Absent when claim wasn't asked. */
  claim?: "assigned" | "already_yours" | "assigned_to_other";
  assignee?: string;
}

export async function logTaskInteraction(params: {
  nestId: string;
  nodeId: string;
  userEmail: string;
  userId?: string | null;
  note: unknown;
  status?: unknown;
  claim?: boolean;
  surface: "mcp" | "api";
  apiKeyId?: string | null;
  client?: ClientMetadata;
}): Promise<TaskLogResult> {
  const { note, status } = parseTaskLogInput({ note: params.note, status: params.status });
  const { storage } = await engineCache.get(params.nestId);
  let metadata: unknown;
  try {
    metadata = (await storage.readDocument(params.nodeId)).frontmatter.metadata;
  } catch {
    throw new NotFoundError(`Node not found: ${params.nodeId}`);
  }
  const edit = await stewardship.canUserEdit(params.nestId, params.nodeId, params.userEmail);
  if (!edit.allowed) {
    throw new ForbiddenError(`You don't have permission to log activity on this task: ${edit.reason}`);
  }

  let claim: TaskLogResult["claim"];
  let assignee = taskFieldsOf(metadata).assignee;
  if (params.claim) {
    const me = params.userEmail.toLowerCase();
    if (!assignee) {
      // Same path (and roster check) as setting the assignee by hand.
      const { node } = await updateNode(
        params.nestId,
        params.nodeId,
        { assignee: me, client: params.client },
        params.userEmail,
      );
      assignee = settableTaskFields(node.frontmatter.metadata).assignee;
      claim = "assigned";
    } else {
      claim = assignee.toLowerCase() === me ? "already_yours" : "assigned_to_other";
    }
  }

  const entry = await recordTaskActivity({
    nestId: params.nestId,
    nodeId: params.nodeId,
    actor: params.userEmail,
    userId: params.userId ?? null,
    note,
    status,
    surface: params.surface,
    apiKeyId: params.apiKeyId ?? null,
    client: params.client,
  });
  return { entry, ...(claim ? { claim } : {}), ...(assignee ? { assignee } : {}) };
}
