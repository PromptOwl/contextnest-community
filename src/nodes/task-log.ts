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
import * as versions from "../governance/version-service.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../shared/errors.js";
import type { ClientMetadata } from "../shared/client-metadata.js";
import { engineCache } from "./engine.js";
import { updateNode } from "./service.js";
import { settableTaskFields, taskFieldsOf } from "./task-fields.js";
import {
  deleteTaskActivity,
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
  // Version before metadata: a write in between makes the claim's expectHead
  // stale, so it conflicts instead of overwriting.
  const readTask = async () => {
    const head = await versions.getCurrentVersion(params.nestId, params.nodeId);
    try {
      const metadata = (await storage.readDocument(params.nodeId)).frontmatter.metadata;
      return { head, assignee: taskFieldsOf(metadata).assignee };
    } catch {
      throw new NotFoundError(`Node not found: ${params.nodeId}`);
    }
  };
  // Permission before existence, so a caller without access can't probe ids.
  const edit = await stewardship.canUserEdit(params.nestId, params.nodeId, params.userEmail);
  if (!edit.allowed) {
    throw new ForbiddenError(`You don't have permission to log activity on this task: ${edit.reason}`);
  }
  let task = await readTask();

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

  let claim: TaskLogResult["claim"];
  let assignee = task.assignee;
  if (params.claim) {
    const me = params.userEmail.toLowerCase();
    try {
      // Two tries: a conflict means someone wrote the task since we read it —
      // re-read, and claim again only if it is still unassigned.
      for (let attempt = 0; !claim; attempt++) {
        if (assignee) {
          claim = assignee.toLowerCase() === me ? "already_yours" : "assigned_to_other";
          break;
        }
        try {
          // Same path (and roster check) as setting the assignee by hand.
          const { node } = await updateNode(
            params.nestId,
            params.nodeId,
            { assignee: me, client: params.client },
            params.userEmail,
            { expectHead: task.head },
          );
          assignee = settableTaskFields(node.frontmatter.metadata).assignee;
          claim = "assigned";
        } catch (err) {
          if (!(err instanceof ConflictError) || attempt > 0) throw err;
          task = await readTask();
          assignee = task.assignee;
        }
      }
    } catch (err) {
      // No entry for a claim that failed: the caller will see the error and retry.
      // A failed cleanup must not hide the claim's own error.
      await deleteTaskActivity(entry.id).catch((e) =>
        console.error("[task-log] could not remove entry after failed claim", entry.id, e),
      );
      throw err;
    }
  }
  return { entry, ...(claim ? { claim } : {}), ...(assignee ? { assignee } : {}) };
}
