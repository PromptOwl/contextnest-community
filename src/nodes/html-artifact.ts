/**
 * The guard for an agent write that is an HTML page (PO-1336).
 *
 * Asked to "post this HTML", an agent tends to send a `document` whose whole
 * body is one ```html block. Stored like that it is a code sample: the person
 * who asked for a page sees its source. An HTML page belongs in an `artifact`
 * node, body = the raw HTML, which the app renders (sandboxed — see
 * shared/artifact-sandbox.ts).
 *
 * This decides, for one create or update, whether the body is such a page and
 * what to store instead. It is applied where an agent writes: the MCP tools,
 * and REST when the caller holds an API key. A person typing in the web app is
 * not second-guessed. Pure — nothing here reads or writes a node.
 */
import { config } from "../config.js";
import { isHtmlBody } from "../shared/artifact-sandbox.js";

const OPEN_FENCE = /^(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+-]*)[ \t]*$/;

/**
 * The inside of a body that is exactly ONE fenced code block holding HTML:
 * a fence labelled html, or an unlabelled one whose content opens as an HTML
 * document. null for anything else — prose around the block, a second block,
 * another language, an unclosed or empty fence — so markdown that merely
 * contains an html sample is never taken for a page.
 */
export function unwrapHtmlFence(body: string): string | null {
  const lines = body.trim().split(/\r?\n/);
  if (lines.length < 3) return null;
  const open = OPEN_FENCE.exec(lines[0]);
  if (!open) return null;
  const [, fence, lang] = open;
  // A closing fence: the same character, at least as long, nothing after it.
  const closes = (line: string) => {
    const t = line.trim();
    return t.length >= fence.length && t === fence[0].repeat(t.length);
  };
  if (!closes(lines[lines.length - 1])) return null;
  const inner = lines.slice(1, -1);
  // A closing fence in the middle means the body is more than one block.
  if (inner.some(closes)) return null;
  const html = inner.join("\n");
  if (!html.trim()) return null;
  const label = lang.toLowerCase();
  if (label === "html" || label === "htm") return html;
  if (label === "" && isHtmlBody(undefined, html)) return html;
  return null;
}

export type HtmlWriteOutcome =
  /** A document-typed write that was an HTML page: stored as an artifact. */
  | "stored_as_artifact"
  /** An artifact whose body arrived inside a code fence: the fence is gone. */
  | "fence_removed"
  /** An HTML page, but this server has artifacts off: stored as sent. */
  | "artifacts_disabled";

export interface HtmlWriteGuard {
  outcome: HtmlWriteOutcome;
  /** The body to store. */
  content: string;
  /** Set when the node must be (re)typed. */
  type?: "artifact";
  /** Whether the body arrived wrapped in a code fence. */
  fenced: boolean;
}

/**
 * What to do with one write. null = nothing; store it as sent.
 *
 * `type` is what the caller sent, `storedType` what the node already is (an
 * update). Only the default `document` type and `artifact` are looked at: a
 * task, glossary or skill whose body happens to be HTML is the caller's call.
 */
export function htmlWriteGuard(
  input: { type?: string | null; storedType?: string | null; content?: unknown },
  artifactsEnabled: boolean = config.TYPE_ARTIFACT_ENABLED,
): HtmlWriteGuard | null {
  const { content } = input;
  if (typeof content !== "string" || !content.trim()) return null;
  const type = input.type || input.storedType || "document";
  const unfenced = unwrapHtmlFence(content);

  if (type === "artifact") {
    // Existing artifacts stay writable when the type is disabled for new
    // nodes, so the fence comes off either way.
    return unfenced === null ? null : { outcome: "fence_removed", content: unfenced, fenced: true };
  }
  if (type !== "document") return null;

  const page = unfenced ?? (isHtmlBody(undefined, content) ? content : null);
  if (page === null) return null;
  const fenced = unfenced !== null;
  if (!artifactsEnabled) return { outcome: "artifacts_disabled", content, fenced };
  return { outcome: "stored_as_artifact", content: page, type: "artifact", fenced };
}

/** One sentence for the caller, so a changed write is never a silent one. */
export function htmlWriteNotice(guard: HtmlWriteGuard): string {
  switch (guard.outcome) {
    case "stored_as_artifact":
      return (
        `Stored as an HTML artifact (type "artifact"), not a markdown document: the whole body was an HTML page` +
        (guard.fenced ? ", so the code fence was removed and it renders as a page instead of showing as code." : ", so it renders as a page.") +
        " To keep HTML as a code sample in a document, put some text around the code block."
      );
    case "fence_removed":
      return "The code fence around the HTML was removed, so the artifact renders as a page instead of showing as code. Send an artifact's content as the raw HTML document.";
    case "artifacts_disabled":
      return (
        "The body is an HTML page, but artifact nodes are disabled on this server (TYPE_ARTIFACT_ENABLED), so it was stored as sent, as a markdown document" +
        (guard.fenced ? " that shows the HTML as code." : ".") +
        " It will not render as a page until a server admin turns artifacts on."
      );
  }
}
