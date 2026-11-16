/**
 * Minimal Block Kit rendering of a ProposalView for the explicit-ask path in
 * S2a: title, summary, folder · nest, a link to the full draft, and the
 * context line. The interactive card (Approve / Edit / Reject buttons, the
 * validator, in-place outcome updates) is S2b.
 *
 * Every string goes through mrkdwn escaping: titles and summaries are
 * model-written from untrusted chat.
 */
import type { ProposalView } from "../../contract.js";
import { escapeMrkdwn } from "../../../notify/slack.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Fallback/notification text: escaped like the blocks, and no mass mention can survive (round 2, L6). */
export function renderCardText(view: ProposalView): string {
  const title = escapeMrkdwn(view.title).replace(/@(channel|here|everyone)\b/gi, "@ $1");
  return clip(`This looks worth keeping: ${title}`, 300);
}

export function renderCard(view: ProposalView): unknown[] {
  const context = [`${esc(view.folder)} · ${esc(view.nest_name)}`, view.note ? esc(view.note) : null, view.disclosure ? esc(view.disclosure) : null].filter(Boolean);
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: clip(`This looks worth keeping: *${esc(view.title)}*\n${esc(view.summary)}`, 2900) } },
    { type: "context", elements: context.map((t) => ({ type: "mrkdwn", text: clip(String(t), 300) })) },
  ];
  if (/^https:\/\//.test(view.draft_url)) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `<${view.draft_url.replace(/[<>|]/g, "")}|Open the full draft>` } });
  }
  return blocks;
}
