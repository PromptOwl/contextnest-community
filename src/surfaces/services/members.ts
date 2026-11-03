/**
 * Fail-closed wrapper around a connector's members() (AC-CON-02). Any throw,
 * timeout, denial, partial page, malformed answer or non-enumerable
 * conversation becomes {known:false}; a partial list never escapes.
 */
import type { ConversationInfo, MembersResult, SurfaceConnector, SurfaceInstallRef, SurfaceMember } from "../contract.js";

export const MEMBERS_TIMEOUT_MS = 10_000;

function validMember(m: unknown): m is SurfaceMember {
  const x = m as SurfaceMember;
  return (
    !!x &&
    typeof x.surface_user_id === "string" &&
    x.surface_user_id.length > 0 &&
    typeof x.is_guest === "boolean" &&
    typeof x.is_external === "boolean" &&
    typeof x.is_bot === "boolean"
  );
}

function validConversation(c: unknown): c is ConversationInfo {
  const x = c as ConversationInfo;
  return !!x && typeof x.is_private === "boolean" && typeof x.is_ext_shared === "boolean" && typeof x.kind === "string";
}

export async function safeMembers(
  connector: SurfaceConnector | null,
  install: SurfaceInstallRef,
  conversation: string,
  opts: { timeoutMs?: number } = {},
): Promise<MembersResult> {
  if (!connector) return { known: false, reason: "no_connector" };
  const timeoutMs = opts.timeoutMs ?? MEMBERS_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const r = (await Promise.race([connector.members(install, conversation), timeout])) as MembersResult | "timeout";
    if (r === "timeout") return { known: false, reason: "timeout" };
    if (!r || r.known !== true) return { known: false, reason: (r as any)?.reason ? String((r as any).reason) : "unknown" };
    if ((r as any).complete !== true) return { known: false, reason: "incomplete" };
    if (!Array.isArray(r.members) || !r.members.every(validMember)) return { known: false, reason: "malformed" };
    if (!validConversation(r.conversation)) return { known: false, reason: "malformed" };
    if (r.conversation.enumerable === false) return { known: false, reason: "not_enumerable" };
    return {
      known: true,
      complete: true,
      members: r.members.map((m) => ({
        surface_user_id: m.surface_user_id,
        is_guest: m.is_guest,
        is_external: m.is_external,
        is_bot: m.is_bot,
        home_tenant: m.home_tenant ?? null,
      })),
      conversation: { ...r.conversation, is_general: !!r.conversation.is_general, enumerable: true },
    };
  } catch {
    return { known: false, reason: "error" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
