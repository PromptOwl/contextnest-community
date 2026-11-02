/**
 * Block Kit rendering and validation (PRD §4.12, AC-CRD-02/05/06/07, N5).
 * Pure: a CardModel (core/card-model.ts) in, Block Kit JSON out.
 *
 * Every model- or nest-derived string is mrkdwn-escaped (`& < >`), so a
 * title can never become a mention, a link or `<!channel>`. Plain-text
 * fields (checkbox options, buttons, modal inputs) are clipped to Slack's
 * limits. `validateBlocks` checks every limit AC-CRD-05 names and is run on
 * every card before it is sent.
 */
import {
  DM_FIRST_LINE,
  PICKABLE_REASONS,
  PRIVATE_NEST_DISCLOSURE,
  REASON_LABELS,
  footerLine,
  kindWord,
  leadIn,
  outcomeContext,
  outcomeHeadline,
  type CardItem,
  type CardModel,
  type CardOutcome,
} from "../../core/card-model.js";
import { fixedCardText } from "../../core/card-text.js";

export const LIMITS = {
  messageBlocks: 50,
  surfaceBlocks: 100,
  sectionText: 3000,
  sectionField: 2000,
  sectionFields: 10,
  header: 150,
  contextElements: 10,
  buttonText: 75,
  optionText: 75,
  optionDescription: 75,
  id: 255,
  value: 2000,
  actionsElements: 25,
  privateMetadata: 3000,
} as const;

export const ACTION = {
  approve: "nest_approve",
  edit: "nest_edit",
  reject: "nest_reject",
  approveSelected: "nest_approve_selected",
  rejectAll: "nest_reject_all",
  updateRecord: "nest_update_record",
  keepRecord: "nest_keep_record",
  select: "nest_select",
  overflow: "nest_overflow",
  confirmYes: "nest_confirm_yes",
  confirmNo: "nest_confirm_no",
  openThread: "home_open_thread",
  reviewInNest: "home_review_in_nest",
  optout: "home_optout",
  dmCapture: "home_dm_capture",
  unlink: "home_unlink",
  boot: "home_boot",
  invite: "home_invite",
  allowBack: "nest_allow_back",
  compare: "nest_compare",
} as const;

export const VIEW = { edit: "nest_edit_modal", reject: "nest_reject_modal", boot: "nest_boot_modal" } as const;

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
export function clip(s: string, n: number): string {
  const a = [...s];
  return a.length > n ? `${a.slice(0, n - 1).join("")}…` : s;
}
const safeUrl = (u: string | null | undefined) => (u && /^https:\/\/[^\s<>|]+$/.test(u) ? u : null);
const link = (u: string | null | undefined, label: string) => {
  const s = safeUrl(u);
  return s ? `<${s}|${esc(label)}>` : esc(label);
};

type Block = Record<string, any>;

const section = (text: string, extra: Record<string, unknown> = {}): Block => ({ type: "section", text: { type: "mrkdwn", text: clip(text, LIMITS.sectionText) }, ...extra });
const context = (lines: Array<string | null | undefined>): Block => ({
  type: "context",
  elements: lines
    .filter((l): l is string => !!l)
    .slice(0, LIMITS.contextElements)
    .map((t) => ({ type: "mrkdwn", text: clip(t, 2000) })),
});
const button = (text: string, actionId: string, value: string, style?: "primary" | "danger"): Block => ({
  type: "button",
  text: { type: "plain_text", text: clip(text, LIMITS.buttonText), emoji: true },
  action_id: actionId,
  value,
  ...(style ? { style } : {}),
});
const val = (o: Record<string, unknown>) => JSON.stringify(o);

function overflow(proposalId: string): Block {
  return {
    type: "overflow",
    action_id: ACTION.overflow,
    options: [{ text: { type: "plain_text", text: "Remove Nest from this conversation" }, value: val({ a: "boot", p: proposalId }) }],
  };
}

function rangeLine(m: CardModel): string {
  const n = `from ${m.message_count} message${m.message_count === 1 ? "" : "s"}`;
  if (m.from_label && m.to_label && m.from_label !== m.to_label) return `${n}, ${m.from_label} to ${m.to_label}`;
  if (m.from_label) return `${n}, ${m.from_label}`;
  return n;
}

function folderLine(m: CardModel, item: CardItem): string {
  const base = `📁 ${esc(item.folder)} in ${esc(m.nest_name)}`;
  return base;
}

function draftLine(m: CardModel, item: CardItem): string {
  return link(item.draft_url, "Full draft (reviewers)");
}

function dmLines(m: CardModel): string[] {
  if (!m.dm) return [];
  return m.dm.first ? [DM_FIRST_LINE, PRIVATE_NEST_DISCLOSURE] : [PRIVATE_NEST_DISCLOSURE];
}

/** The card's text fallback (notifications, screen readers): no body text. */
export function cardFallback(m: CardModel): string {
  if (m.outcome) return clip(esc(outcomeHeadline(m.outcome).replace(/<@[A-Z0-9_]+>/g, "a reviewer")), 300);
  if (m.items.length > 1) return `Nest: ${m.items.length} things worth keeping`;
  const it = m.items[0];
  if (!it) return "Nest: a proposal";
  if (m.kind === "conflict" && !m.surface_ok) return esc(fixedCardText([{ kind: "correction", op: "edit" }], m.nest_name).title);
  return clip(`Nest: ${esc(shownText(m, it).title)}`, 300);
}

/** Every card the renderer can produce, by model. */
export function renderCardBlocks(m: CardModel): Block[] {
  if (m.outcome) return renderOutcome(m);
  if (m.kind === "agent") return renderAgent(m);
  if (m.kind === "conflict") return renderConflict(m);
  if (m.items.length > 1) return renderMerged(m);
  return renderSingle(m);
}

/** S2a H1/N1: model-written text appears only when surface_ok; otherwise every
 *  card kind shows the fixed template (plus the readers-only link). */
function shownText(m: CardModel, it: CardItem): { title: string; summary: string | null } {
  if (m.surface_ok) return { title: it.title, summary: it.summary };
  // S2a's one fixed template (core/card-text.ts), per item.
  return { title: fixedCardText([{ kind: it.kind, op: it.op }], m.nest_name).title, summary: null };
}
const titleBlock = (t: { title: string; summary: string | null }) => (t.summary ? `*${esc(t.title)}*\n${esc(t.summary)}` : esc(t.title));

/** Alias kept for S2a's naming (the fallback text must go through it). */
export const escapeMrkdwn = esc;

/** R2: Edit only when the named reviewer can edit (approve-with-edits rule). */
const editBtn = (m: CardModel, v: string): Block[] => (m.can_edit === true ? [button("Edit", ACTION.edit, v)] : []);

function reviewerLine(m: CardModel): Block | null {
  return m.reviewer ? section(`For review: ${m.reviewer}`) : null;
}

function renderSingle(m: CardModel): Block[] {
  const it = m.items[0];
  const v = val({ p: m.proposal_id });
  return [
    section(esc(leadIn(it.kind, m.forced))),
    section(titleBlock(shownText(m, it)), { accessory: overflow(m.proposal_id) }),
    context([folderLine(m, it), rangeLine(m), draftLine(m, it)]),
    context([it.why && m.surface_ok ? `Why: ${esc(it.why)}` : "Why: worth keeping for the team", m.note ? esc(m.note) : null, ...dmLines(m)]),
    reviewerLine(m),
    { type: "actions", block_id: "nest_decide", elements: [button("Approve", ACTION.approve, v, "primary"), ...editBtn(m, v), button("Reject", ACTION.reject, v)] },
    context([footerLine(m.expires_label)]),
  ].filter(Boolean) as Block[];
}

function renderMerged(m: CardModel): Block[] {
  const v = val({ p: m.proposal_id });
  const blocks: Block[] = [
    section(
      m.forced ? esc(leadIn("decision", true)) : `This thread has ${m.items.length} things worth keeping:`,
      { accessory: overflow(m.proposal_id) },
    ),
  ];
  // Each item's summary sits in a section ABOVE the checkboxes (AC-CRD-05).
  for (const it of m.items) {
    blocks.push(section(titleBlock(shownText(m, it))));
    blocks.push(context([folderLine(m, it), draftLine(m, it), it.why && m.surface_ok ? `Why: ${esc(it.why)}` : null]));
  }
  const options = m.items.map((it, i) => ({
    text: { type: "plain_text", text: clip(m.surface_ok ? it.title : `Item ${i + 1}: ${kindWord(it.kind)}`, LIMITS.optionText) },
    description: { type: "plain_text", text: clip(`${kindWord(it.kind)} · ${it.folder}`, LIMITS.optionDescription) },
    value: it.id,
  }));
  blocks.push({ type: "actions", block_id: "nest_items", elements: [{ type: "checkboxes", action_id: ACTION.select, options, initial_options: options }] });
  blocks.push(context([rangeLine(m), m.note ? esc(m.note) : null, ...dmLines(m)]));
  const r = reviewerLine(m);
  if (r) blocks.push(r);
  blocks.push({
    type: "actions",
    block_id: "nest_decide",
    elements: [button("Approve selected", ACTION.approveSelected, v, "primary"), ...editBtn(m, v), button("Reject all", ACTION.rejectAll, v)],
  });
  blocks.push(context([footerLine(m.expires_label)]));
  return blocks;
}

function renderConflict(m: CardModel): Block[] {
  const it = m.items[0];
  const v = val({ p: m.proposal_id });
  if (!m.surface_ok) {
    // S2a H1: a correction card in a room where not everyone reads the nest
    // shows a FIXED template only, plus the readers-only link.
    const blocks: Block[] = [
      section(esc(fixedCardText([{ kind: "correction", op: "edit" }], m.nest_name).title), {
        accessory: { type: "button", text: { type: "plain_text", text: "Compare in the nest" }, action_id: ACTION.compare, url: safeUrl(m.compare_url ?? it.draft_url) ?? undefined, value: v },
      }),
      context([draftLine(m, it), m.note ? esc(m.note) : null, ...dmLines(m)]),
    ];
    const r0 = reviewerLine(m);
    if (r0) blocks.push(r0);
    blocks.push({
      type: "actions",
      block_id: "nest_decide",
      elements: [button("Update the record", ACTION.updateRecord, v, "primary"), ...editBtn(m, v), button("Keep the record", ACTION.keepRecord, v)],
    });
    blocks.push(context([footerLine(m.expires_label)]));
    return blocks;
  }
  const blocks: Block[] = [section(esc(leadIn("correction", m.forced))), section(`*${esc(it.title)}*`, { accessory: overflow(m.proposal_id) })];
  if (it.on_record) {
    blocks.push({
      type: "section",
      fields: [
        { type: "mrkdwn", text: clip(`*On record*\n${esc(it.on_record)}`, LIMITS.sectionField) },
        { type: "mrkdwn", text: clip(`*This thread*\n${esc(it.summary)}`, LIMITS.sectionField) },
      ],
    });
    blocks.push(context([`On record: ${esc(it.record_title ?? it.title)} in ${esc(m.nest_name)}`, `This thread: ${rangeLine(m)}`, draftLine(m, it)]));
  } else {
    blocks.push(
      section("This thread may change a record that some people here can't read. Compare it in the nest before deciding.", {
        accessory: { type: "button", text: { type: "plain_text", text: "Compare in the nest" }, action_id: ACTION.compare, url: safeUrl(m.compare_url ?? it.draft_url) ?? undefined, value: v },
      }),
    );
  }
  blocks.push(context([it.why ? `Why: ${esc(it.why)}` : null, m.note ? esc(m.note) : null, ...dmLines(m)]));
  const r = reviewerLine(m);
  if (r) blocks.push(r);
  blocks.push({
    type: "actions",
    block_id: "nest_decide",
    elements: [button("Update the record", ACTION.updateRecord, v, "primary"), ...editBtn(m, v), button("Keep the record", ACTION.keepRecord, v)],
  });
  blocks.push(context([footerLine(m.expires_label)]));
  return blocks;
}

function renderAgent(m: CardModel): Block[] {
  const it = m.items[0];
  const v = val({ p: m.proposal_id });
  return [
    section(esc(leadIn("agent_suggestion", false))),
    // INFO a: agent cards follow the surface_ok rule like every other kind.
    section(titleBlock(shownText(m, it)), { accessory: overflow(m.proposal_id) }),
    context([folderLine(m, it), draftLine(m, it)]),
    reviewerLine(m),
    { type: "actions", block_id: "nest_decide", elements: [button("Save agent", ACTION.approve, v, "primary"), ...editBtn(m, v), button("Don't suggest this", ACTION.reject, v)] },
    context([footerLine(m.expires_label)]),
  ].filter(Boolean) as Block[];
}

function renderOutcome(m: CardModel): Block[] {
  const raw = m.outcome!;
  // Escape every model/nest-derived part; `by` is a mention we built (<@U…>)
  // or an escaped display name — never re-derived from escaped text.
  const by = (b: string) => (/^<@[A-Z0-9_]+>$/.test(b) ? b : esc(b));
  const o =
    raw.type === "approved"
      ? { ...raw, by: by(raw.by), kept: raw.kept.map((k) => ({ ...k, path: esc(k.path) })), notKept: raw.notKept.map(esc), editedBy: raw.editedBy ? esc(raw.editedBy) : raw.editedBy }
      : raw.type === "rejected"
        ? { ...raw, by: by(raw.by) }
        : { ...raw, title: esc(raw.title) };
  if (!m.surface_ok) {
    // §4.17 / S2a N1: no model- or nest-derived text in a room where not
    // everyone reads the nest — outcome cards included.
    const generic: CardOutcome =
      o.type === "approved"
        ? { ...o, kept: o.kept.map((k) => ({ path: "a record", version: k.version })), notKept: o.notKept.map(() => "an item"), editedBy: null }
        : o.type === "rejected"
          ? o
          : { ...o, title: "this proposal" };
    return [section(outcomeHeadline(generic)), context(outcomeContext(generic, esc(m.nest_name)))];
  }
  const blocks: Block[] = [section(outcomeHeadline(o))];
  if (o.type === "approved" && (o.kept.length > 1 || o.notKept.length)) {
    const lines = [...o.kept.map((k) => `✅ ${k.path}${k.version != null ? ` · v${k.version}` : ""}`), ...o.notKept.map((t) => `Not kept: ${t}`)];
    blocks.push(section(lines.join("\n")));
  }
  blocks.push(context(outcomeContext(o, esc(m.nest_name))));
  return blocks;
}

// ─── ephemeral notes ─────────────────────────────────────────────────────────

export function renderConfirm(prompt: string, value: string): Block[] {
  // The prompt bolds the verb with **…**; Slack mrkdwn bold is *…*.
  return [
    section(esc(prompt).replace(/\*\*(.+?)\*\*/g, "*$1*")),
    { type: "actions", block_id: "nest_confirm", elements: [button("Yes, that's me", ACTION.confirmYes, value, "primary"), button("That's not me", ACTION.confirmNo, value, "danger")] },
  ];
}

export function renderNote(text: string, buttonSpec?: { text: string; url?: string; actionId: string; value?: string }): Block[] {
  const b: Block[] = [section(text)];
  if (buttonSpec) {
    b.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: clip(buttonSpec.text, LIMITS.buttonText) },
          action_id: buttonSpec.actionId,
          ...(buttonSpec.url && safeUrl(buttonSpec.url) ? { url: buttonSpec.url } : {}),
          ...(buttonSpec.value ? { value: buttonSpec.value } : {}),
        },
      ],
    });
  }
  return b;
}

// ─── modals ──────────────────────────────────────────────────────────────────

export interface EditModalItem {
  id: string;
  title: string;
  summary: string;
  body: string;
  kind: string;
  folder: string;
}

const input = (blockId: string, label: string, initial: string, multiline: boolean, max: number): Block => ({
  type: "input",
  block_id: blockId,
  label: { type: "plain_text", text: clip(label, 2000) },
  element: { type: "plain_text_input", action_id: "v", multiline, initial_value: initial.slice(0, max), max_length: max },
});

export function renderEditModal(items: EditModalItem[], meta: string, nestName: string, target: string): Block {
  const blocks: Block[] = [{ type: "context", elements: [{ type: "mrkdwn", text: clip(`Saving to ${esc(target)} in ${esc(nestName)}. The folder and nest can't be changed here.`, 2000) }] }];
  for (const it of items) {
    if (items.length > 1) {
      blocks.push({
        type: "input",
        block_id: `keep:${it.id}`,
        optional: true,
        label: { type: "plain_text", text: clip(`Keep: ${it.title}`, 2000) },
        element: {
          type: "checkboxes",
          action_id: "v",
          options: [{ text: { type: "plain_text", text: "Keep this one" }, value: "keep" }],
          initial_options: [{ text: { type: "plain_text", text: "Keep this one" }, value: "keep" }],
        },
      });
    }
    blocks.push(input(`title:${it.id}`, items.length > 1 ? `Title (${kindWord(it.kind)} · ${it.folder})` : "Title", it.title, false, 80));
    blocks.push(input(`summary:${it.id}`, "Summary (1–3 sentences)", it.summary, true, 400));
    blocks.push(input(`body:${it.id}`, "Draft", it.body, true, 2000));
  }
  return {
    type: "modal",
    callback_id: VIEW.edit,
    private_metadata: meta,
    title: { type: "plain_text", text: "Edit and approve" },
    submit: { type: "plain_text", text: "Approve" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

export function renderRejectModal(meta: string): Block {
  const options = PICKABLE_REASONS.map((r) => ({ text: { type: "plain_text", text: REASON_LABELS[r] }, value: r }));
  return {
    type: "modal",
    callback_id: VIEW.reject,
    private_metadata: meta,
    title: { type: "plain_text", text: "Reject" },
    submit: { type: "plain_text", text: "Reject" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      section("Why isn't this worth keeping? Optional. Nest won't propose it again for 7 days, and the draft is deleted."),
      { type: "input", block_id: "reason", optional: true, label: { type: "plain_text", text: "Reason" }, element: { type: "radio_buttons", action_id: "v", options } },
    ],
  };
}

export function renderBootModal(meta: string, conversationName: string | null): Block {
  const where = conversationName ? `#${conversationName.replace(/^#/, "")}` : "this conversation";
  return {
    type: "modal",
    callback_id: VIEW.boot,
    private_metadata: meta,
    title: { type: "plain_text", text: "Remove Nest" },
    submit: { type: "plain_text", text: "Remove Nest" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      section(
        `Remove Nest from ${esc(where)}?\n• Nest stops reading messages here at once.\n• Messages it was holding from here are deleted.\n• Proposals waiting here are withdrawn and their drafts deleted.\n• Your admin is told who removed it and when, not why. Nest only comes back if an admin re-adds it and you agree, or you've left.`,
      ),
    ],
  };
}

// ─── validator (AC-CRD-05) ───────────────────────────────────────────────────

export type BlockSurface = "message" | "modal" | "home";

function textOf(t: unknown): string {
  return t && typeof t === "object" && typeof (t as any).text === "string" ? (t as any).text : "";
}

/** Every Block Kit limit AC-CRD-05 names; [] when the blocks are valid. */
export function validateBlocks(blocks: Block[], surface: BlockSurface): string[] {
  const v: string[] = [];
  const max = surface === "message" ? LIMITS.messageBlocks : LIMITS.surfaceBlocks;
  if (blocks.length > max) v.push(`blocks: ${blocks.length} > ${max}`);
  const chkId = (where: string, id: unknown) => {
    if (typeof id === "string" && id.length > LIMITS.id) v.push(`${where}: id > ${LIMITS.id}`);
  };
  const chkValue = (where: string, x: unknown) => {
    if (typeof x === "string" && x.length > LIMITS.value) v.push(`${where}: value > ${LIMITS.value}`);
  };
  const chkElement = (where: string, el: Block) => {
    chkId(`${where}.action_id`, el.action_id);
    chkValue(where, el.value);
    if (el.type === "button" && [...textOf(el.text)].length > LIMITS.buttonText) v.push(`${where}: button text > ${LIMITS.buttonText}`);
    for (const key of ["options", "initial_options"]) {
      for (const [i, o] of ((el[key] as Block[]) ?? []).entries()) {
        if ([...textOf(o.text)].length > LIMITS.optionText) v.push(`${where}.${key}[${i}]: option text > ${LIMITS.optionText}`);
        if (o.description && [...textOf(o.description)].length > LIMITS.optionDescription) v.push(`${where}.${key}[${i}]: description > ${LIMITS.optionDescription}`);
        chkValue(`${where}.${key}[${i}]`, o.value);
      }
    }
  };
  blocks.forEach((b, i) => {
    const w = `blocks[${i}]`;
    chkId(`${w}.block_id`, b.block_id);
    switch (b.type) {
      case "section":
        if ([...textOf(b.text)].length > LIMITS.sectionText) v.push(`${w}: section text > ${LIMITS.sectionText}`);
        if (Array.isArray(b.fields)) {
          if (b.fields.length > LIMITS.sectionFields) v.push(`${w}: fields > ${LIMITS.sectionFields}`);
          for (const f of b.fields) if ([...textOf(f)].length > LIMITS.sectionField) v.push(`${w}: field > ${LIMITS.sectionField}`);
        }
        if (b.accessory) chkElement(`${w}.accessory`, b.accessory);
        break;
      case "header":
        if ([...textOf(b.text)].length > LIMITS.header) v.push(`${w}: header > ${LIMITS.header}`);
        break;
      case "context":
        if ((b.elements ?? []).length > LIMITS.contextElements) v.push(`${w}: context elements > ${LIMITS.contextElements}`);
        break;
      case "actions":
        if ((b.elements ?? []).length > LIMITS.actionsElements) v.push(`${w}: actions elements > ${LIMITS.actionsElements}`);
        for (const [j, el] of ((b.elements as Block[]) ?? []).entries()) chkElement(`${w}.elements[${j}]`, el);
        break;
      case "input":
        if (b.element) chkElement(`${w}.element`, b.element);
        break;
    }
  });
  return v;
}

/** A modal / Home view's own limits, plus its blocks. */
export function validateView(view: Block, surface: "modal" | "home"): string[] {
  const v = validateBlocks((view.blocks as Block[]) ?? [], surface);
  if (typeof view.private_metadata === "string" && view.private_metadata.length > LIMITS.privateMetadata) v.push(`private_metadata > ${LIMITS.privateMetadata}`);
  if (view.title && [...textOf(view.title)].length > 24) v.push("title > 24");
  return v;
}

/** Merged cards: every item's summary section sits above the checkboxes. */
export function summariesAboveCheckboxes(blocks: Block[]): boolean {
  const cb = blocks.findIndex((b) => b.type === "actions" && (b.elements ?? []).some((e: Block) => e.type === "checkboxes"));
  if (cb < 0) return true;
  const options: string[] = blocks[cb].elements.find((e: Block) => e.type === "checkboxes").options.map((o: Block) => o.value);
  return options.length > 0 && options.every((_, i) => blocks.slice(0, cb).filter((b) => b.type === "section" && /\*.+\*\n/.test(textOf(b.text))).length > i);
}
