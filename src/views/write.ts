/**
 * View write-back — a view's html block may change rows of a table the view
 * shows, as the VIEWER, through the normal governed write path.
 *
 * Opt-in is a layout field: `{ id: "h", html: { ref, data_from, write_to: ["d"] } }`
 * where each `write_to` entry names a `data` block (bound to a table node).
 * Being part of the layout, it changes only through an approved view version.
 *
 * The flow, end to end:
 *   frame ── postMessage({type:"nest-write", block:"d", ops, base_version?, id?}) ──▶ view page
 *   view page (WRITE_BRIDGE_JS) ── POST /nests/:n/nodes/<table>/rows (viewer's session) ──▶ server
 *   view page ── postMessage({type:"nest-write-result", …}) ──▶ that frame
 *
 * The frame never touches the network: its CSP keeps `connect-src 'none'`.
 * The view page — which otherwise runs no script at all — gets exactly one
 * script, this bridge, pinned by hash in its CSP, plus `connect-src 'self'`.
 * Only pages that have at least one trusted write target get it; every other
 * view page is served byte-for-byte as before.
 *
 * Trust (decideWriteTrust): the bridge is offered for an html block only when
 * the served view version is approved, the artifact has an approved version
 * (the one its frame serves), and every author of both chains is a real,
 * current member with write access — so code nobody with write access wrote
 * or reviewed can't make a writer's browser write. Permissions on the write
 * itself are the viewer's, checked by the server on every request.
 */
import { createHash, randomBytes } from "crypto";
import type { ViewBlock, ViewMeta } from "@promptowl/contextnest-engine";

type HtmlBlock = Extract<ViewBlock, { html: unknown }>;
import { blockIdOf, blockKindOf, normalizeDataFrom, servedBlocks, type AuthorInfo, type ResolvedBlock } from "./core.js";
import { ROW_OPS_CAPS } from "../tables/row-ops.js";
import { config } from "../config.js";

/** Per-message and per-frame limits the bridge enforces before any request. */
export const WRITE_CAPS = {
  /** Same cap the endpoint enforces. */
  MAX_OPS: ROW_OPS_CAPS.MAX_OPS,
  /** Serialized request body. */
  MAX_MESSAGE_BYTES: 65536,
  /** Requests per frame per rolling minute. */
  MAX_WRITES_PER_MINUTE: 20,
} as const;

/** `CN_VIEW_WRITES=off` removes every write bridge (`CN_VIEW_DATA=off` does too). */
export function viewWritesKillSwitch(): boolean {
  return config.CN_VIEW_WRITES_OFF;
}

/** html block id → its `write_to` (ordered, de-duplicated), for the served
 *  html blocks that declare a non-empty one. */
export function declaredWriteTo(view: ViewMeta): Map<string, string[]> {
  const out = new Map<string, string[]>();
  servedBlocks(view).forEach((b, i) => {
    if (blockKindOf(b) !== "html") return;
    const ids = normalizeDataFrom((b.html as HtmlBlock["html"] | undefined)?.write_to);
    if (ids.length) out.set(blockIdOf(b, i), ids);
  });
  return out;
}

/** The `write_to` ids that name a `data` block resolved (for the viewer) to a
 *  table, mapped to that table's node id. Anything else is dropped. */
export function writeTargets(writeTo: string[], resolved: ResolvedBlock[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of writeTo) {
    const b = resolved.find((r) => r.id === id);
    if (!b || !b.ok || b.kind !== "data") continue;
    const table = b.sources?.[0];
    if (table) out[id] = table;
  }
  return out;
}

const WRITERS = new Set(["write", "admin", "owner"]);

export type WriteTrust = { ok: true } | { ok: false; reason: string };

/** Whether an html block's code may ask a viewer's browser to write. Pure;
 *  the first failure refuses. */
export function decideWriteTrust(i: {
  killSwitch: boolean;
  viewApproved: boolean;
  artifactApproved: boolean;
  authors: AuthorInfo[];
  authorsIncomplete: boolean;
}): WriteTrust {
  if (i.killSwitch) return { ok: false, reason: "kill_switch" };
  if (!i.viewApproved) return { ok: false, reason: "view_not_approved" };
  if (!i.artifactApproved) return { ok: false, reason: "artifact_not_approved" };
  if (i.authorsIncomplete) return { ok: false, reason: "authors_incomplete" };
  if (i.authors.length === 0) return { ok: false, reason: "no_authors" };
  for (const a of i.authors) {
    if (!a.email || a.isSystem || a.email.startsWith("system:")) return { ok: false, reason: "system_or_empty_author" };
    if (!a.userId) return { ok: false, reason: "unknown_author" };
    if (a.approvedOnly || !WRITERS.has(a.nestPermission)) return { ok: false, reason: "author_cannot_write" };
  }
  return { ok: true };
}

/** `/nests/:nestId/nodes/<table id>/rows` — the only URL a bridge calls. */
export function rowsUrl(nestId: string, tableId: string): string {
  return `/nests/${encodeURIComponent(nestId)}/nodes/${tableId.split("/").map(encodeURIComponent).join("/")}/rows`;
}

/** html block id → its frame token and { data block id → rows URL } */
export type WriteFrames = Record<string, { token: string; targets: Record<string, string> }>;

/** A frame token: 18 random bytes, base64url (24 chars). */
export function mintFrameToken(): string {
  return randomBytes(18).toString("base64url");
}
export const FRAME_TOKEN_RE = /^[A-Za-z0-9_-]{24}$/;

/** The element a write frame's artifact reads its token from:
 *  `JSON.parse(document.getElementById("nest-write-token").textContent)`. */
export function frameTokenTag(token: string): string {
  if (!FRAME_TOKEN_RE.test(token)) throw new Error("invalid frame token");
  return `<script type="application/json" id="nest-write-token">"${token}"</script>`;
}

const LS = new RegExp(String.fromCharCode(0x2028), "g");
const PS = new RegExp(String.fromCharCode(0x2029), "g");

/** The inert JSON the bridge reads, escaped to stay inside its <script>. */
export function writeConfigJson(frames: WriteFrames): string {
  const cfg = {
    v: 1,
    caps: {
      maxOps: WRITE_CAPS.MAX_OPS,
      maxBytes: WRITE_CAPS.MAX_MESSAGE_BYTES,
      perMinute: WRITE_CAPS.MAX_WRITES_PER_MINUTE,
    },
    frames,
  };
  return JSON.stringify(cfg)
    .replace(/</g, "\\u003c")
    .replace(LS, "\\u2028")
    .replace(PS, "\\u2029");
}

/**
 * The bridge. Plain ES5, no dependencies, no string built from message data
 * ever reaches the URL, method, credentials or headers. Tests execute this
 * exact text (test/views-write-bridge.test.ts).
 *
 *  - Accepts only `event.source` === the contentWindow of one of this page's
 *    `iframe[data-cn-block]` elements, from origin "null" (the frames are
 *    sandboxed without allow-same-origin, so their origin is opaque).
 *  - The frame's block id is read from that element, never from the message.
 *  - The target must be in that block's write_to (the server-rendered config).
 *  - The message must carry that frame's token. The window handle survives a
 *    navigation of the frame (to any same-origin page, e.g. another
 *    artifact's /hosted), so the handle alone is not the frame's document:
 *    the token is minted per page serve, reaches only the frame document the
 *    server served for that block (and only when it serves the artifact
 *    version the page checked), and never leaves the browser.
 *  - Caps: ops count, body size, one request in flight per frame, a rolling
 *    per-minute budget per frame.
 *  - Replies to the source window only. Its origin is opaque, so the target
 *    origin can only be "*"; the reply carries status fields, never row data.
 */
export const WRITE_BRIDGE_JS = [
  "(function(){",
  '"use strict";',
  'var el=document.getElementById("cn-write-config");if(!el)return;',
  "var cfg;try{cfg=JSON.parse(el.textContent||\"\");}catch(e){return;}",
  "if(!cfg||typeof cfg!==\"object\"||!cfg.frames||!cfg.caps)return;",
  "var own=Object.prototype.hasOwnProperty;var state={};",
  "function frameOf(src){var l=document.querySelectorAll(\"iframe[data-cn-block]\");for(var i=0;i<l.length;i++){if(l[i].contentWindow===src)return l[i];}return null;}",
  "function reply(win,id,out){out.type=\"nest-write-result\";if(id!==undefined)out.id=id;try{win.postMessage(out,\"*\");}catch(e){}}",
  "function pick(j,out,keys){for(var i=0;i<keys.length;i++){var k=keys[i];if(j&&own.call(j,k))out[k]=j[k];}}",
  'window.addEventListener("message",function(ev){',
  "var m=ev.data;if(!m||typeof m!==\"object\"||m.type!==\"nest-write\")return;",
  "if(!ev.source||ev.origin!==\"null\")return;",
  "var f=frameOf(ev.source);if(!f)return;",
  "var src=ev.source;var hid=f.getAttribute(\"data-cn-block\");",
  "var id=(typeof m.id===\"string\"&&m.id.length<=64)?m.id:undefined;",
  "var blk=typeof m.block===\"string\"?m.block:null;",
  "var fr=(hid!==null&&own.call(cfg.frames,hid))?cfg.frames[hid]:null;var targets=fr&&fr.targets;",
  "var url=(blk!==null&&targets&&own.call(targets,blk)&&typeof targets[blk]===\"string\")?targets[blk]:null;",
  "if(!url)return reply(src,id,{ok:false,block:blk,error:\"not_writable\"});",
  "if(typeof fr.token!==\"string\"||m.token!==fr.token)return reply(src,id,{ok:false,block:blk,error:\"bad_token\"});",
  "if(!Array.isArray(m.ops)||m.ops.length===0)return reply(src,id,{ok:false,block:blk,error:\"bad_request\"});",
  "if(m.ops.length>cfg.caps.maxOps)return reply(src,id,{ok:false,block:blk,error:\"too_many_ops\"});",
  "var payload={ops:m.ops};",
  "if(typeof m.base_version===\"number\"&&m.base_version>=0&&m.base_version%1===0)payload.base_version=m.base_version;",
  "payload.submit_review=true;",
  "var body;try{body=JSON.stringify(payload);}catch(e){return reply(src,id,{ok:false,block:blk,error:\"bad_request\"});}",
  "var size=typeof body===\"string\"?(typeof TextEncoder===\"function\"?new TextEncoder().encode(body).length:body.length*3):Infinity;",
  "if(size>cfg.caps.maxBytes)return reply(src,id,{ok:false,block:blk,error:\"too_large\"});",
  "var st=own.call(state,hid)?state[hid]:(state[hid]={busy:false,times:[]});",
  "if(st.busy)return reply(src,id,{ok:false,block:blk,error:\"busy\"});",
  "var now=Date.now();var kept=[];for(var i=0;i<st.times.length;i++){if(now-st.times[i]<60000)kept.push(st.times[i]);}st.times=kept;",
  "if(st.times.length>=cfg.caps.perMinute)return reply(src,id,{ok:false,block:blk,error:\"rate_limited\"});",
  "st.times.push(now);st.busy=true;",
  "fetch(url,{method:\"POST\",credentials:\"same-origin\",headers:{\"Content-Type\":\"application/json\"},body:body,cache:\"no-store\",redirect:\"error\"})",
  ".then(function(r){return r.json().then(function(j){return{s:r.status,j:j};},function(){return{s:r.status,j:null};});})",
  ".then(function(res){st.busy=false;var ok=res.s>=200&&res.s<300;var out={ok:ok,block:blk,status:res.s};",
  "if(ok){pick(res.j,out,[\"state\",\"version\",\"review_id\",\"applied\",\"unchanged\"]);}",
  "else{out.error=(res.j&&typeof res.j.error===\"string\")?res.j.error:\"write_failed\";if(res.j&&typeof res.j.current_version===\"number\")out.current_version=res.j.current_version;}",
  "reply(src,id,out);},function(){st.busy=false;reply(src,id,{ok:false,block:blk,error:\"network_error\"});});",
  "});",
  "})();",
].join("");

let hashCache: string | null = null;
/** `'sha256-…'` of WRITE_BRIDGE_JS, for the page's script-src. */
export function writeBridgeCspHash(): string {
  hashCache ??= `'sha256-${createHash("sha256").update(WRITE_BRIDGE_JS, "utf8").digest("base64")}'`;
  return hashCache;
}

/** The view page CSP with the bridge allowed: `script-src` names only the
 *  bridge's hash, and `connect-src 'self'` lets it reach the rows endpoint.
 *  Everything else in the page policy is kept. */
export function withWriteBridge(pageCsp: string): string {
  const parts = pageCsp.split("; ").map((d) => (d.startsWith("script-src ") ? `script-src ${writeBridgeCspHash()}` : d));
  const at = parts.findIndex((d) => d.startsWith("frame-src "));
  parts.splice(at >= 0 ? at + 1 : parts.length, 0, "connect-src 'self'");
  return parts.join("; ");
}
