/**
 * The kinds of agent this server can offer a nest (PO-1201, team chat C10).
 *
 * A typed list in code, not a table: every kind here IS an existing feature
 * — Hootie, a metacognition agent, an agent webhook, a nest-scoped agent key
 * — described in plain words, with what it needs, what it may do and who may
 * hire it. "Hiring" one creates that existing thing through its own service
 * (service.ts); this module only describes and answers "can this server
 * offer it right now, and to this caller?".
 *
 * src/workflow declares no installable agent kind of its own today (runs are
 * executed by external runners that claim them), so nothing is added from
 * there; when it does, it is one more entry here.
 */
import { config } from "../config.js";
import { resolveModelCredential } from "../shared/model-credential.js";
import { metacognitionEnabled } from "../metacognition/manage.js";
import type { HireKind } from "./rules.js";

export type { HireKind } from "./rules.js";

export type HireBy = "owner or admin" | "writer";

export interface CatalogEntry {
  kind: HireKind;
  name: string;
  /** One paragraph in plain words. */
  description: string;
  /** What it does in a channel — also the one line an announcement uses. */
  in_channel: string;
  needs: string[];
  permissions: string[];
  cost: string;
  hire_by: HireBy;
  config_fields: Array<{ name: string; required: boolean; description: string }>;
  /** Where the existing feature is managed in the app. */
  manage: string;
}

export interface CatalogView extends CatalogEntry {
  available: boolean;
  reason: string | null;
}

export const CATALOG: readonly CatalogEntry[] = [
  {
    kind: "hootie",
    name: "Hootie",
    description:
      "The nest's own assistant. It answers questions from what the nest knows — documents, boards, decisions — with citations, as the person asking, so it never sees more than they can. It writes nothing on its own.",
    in_channel: "answers questions from the nest, with citations",
    needs: ["Hootie switched on in Server settings", "a model key or gateway on the server"],
    permissions: ["reads what the asker can read", "answers only people signed in — never an API key"],
    cost: "model usage per question, on the server's model credential",
    hire_by: "owner or admin",
    config_fields: [],
    manage: "settings/hootie",
  },
  {
    kind: "watcher",
    name: "Watcher",
    description:
      "A metacognition agent that reads a channel (or the whole nest) on a schedule or when run, and comments when a thread has settled into a decision or a task the nest does not record yet, or contradicts an approved document. It proposes nothing and edits nothing: comments only.",
    in_channel: "reads the channel and points out what is settled but not yet recorded",
    needs: ["the workflow plane and metacognition switched on", "a model key or gateway on the server"],
    permissions: ["reads the channels in its scope as its own persona", "comments only — no edits, no proposals"],
    cost: "model usage per run, capped by the agent's own limits",
    hire_by: "owner or admin",
    config_fields: [],
    manage: "workflows/metacognition",
  },
  {
    kind: "webhook",
    name: "Webhook agent",
    description:
      "Your own runner, any vendor. Give it an @handle and a public https URL; when a person @mentions the handle in a channel or a document thread, the server sends the URL one signed POST naming the thread, and the runner reads and replies with its own key.",
    in_channel: "is woken by an @mention and replies with its own key",
    needs: ["a public https URL for the runner (a tunnel for a local one)", "a key of its own to read and post with"],
    permissions: ["receives a signed event with the thread reference", "reads and writes only with whatever key it holds"],
    cost: "none on this server; the runner pays for its own model",
    hire_by: "owner or admin",
    config_fields: [{ name: "url", required: true, description: "Public https URL the wake-up is POSTed to." }],
    manage: "settings/agent-webhooks",
  },
  {
    kind: "key",
    name: "Key agent",
    description:
      "An agent that connects over MCP with a key of its own, labelled with its @handle. It finds the threads that tag it in its work queue (context_my_work), reads channels and posts as itself. No URL needed, so it works behind a firewall or on a laptop.",
    in_channel: "finds its @mentions in its work queue and posts as itself",
    needs: ["a label (the @handle)", "an MCP client to paste the key into"],
    permissions: ["a write key scoped to this nest only, acting with the hiring person's own permission"],
    cost: "none on this server; the agent pays for its own model",
    hire_by: "writer",
    config_fields: [],
    manage: "settings/hire",
  },
];

export const KINDS: readonly HireKind[] = CATALOG.map((e) => e.kind);

export function catalogEntry(kind: HireKind): CatalogEntry {
  return CATALOG.find((e) => e.kind === kind)!;
}

/** Why this SERVER can't offer the kind right now, or null when it can. */
export function serverUnavailableReason(kind: HireKind): string | null {
  switch (kind) {
    case "hootie":
      if (!config.HOOTIE_ENABLED) return "Hootie is off on this server. A server admin turns it on under Settings → Hootie.";
      if (!resolveModelCredential()) return "Hootie has no model key. A server admin adds one, or a model gateway, under Settings → Hootie.";
      return null;
    case "watcher":
      if (!metacognitionEnabled())
        return "Metacognition agents are not enabled on this server (FEATURE_METACOGNITION and FEATURE_WORKFLOW_PLANE).";
      if (!resolveModelCredential()) return "A watcher needs a model key or gateway on the server.";
      return null;
    default:
      return null;
  }
}
