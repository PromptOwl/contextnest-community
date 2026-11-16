/**
 * Binding state machine (§12 R3): active | paused_guard | paused_by_member |
 * removed. Pure transition rules; the binding service applies them.
 *
 * - The guard only ever pauses an active binding. Nothing resumes silently:
 *   paused_guard → active needs an admin Resume with the guard passing.
 * - paused_by_member → active needs an admin re-bind, allowed only once the
 *   booting member consented or has left.
 * - removed is terminal; re-creating the binding goes through the guard again.
 */
export type BindingStatus = "active" | "paused_guard" | "paused_by_member" | "removed";

export const BINDING_STATUSES: readonly BindingStatus[] = ["active", "paused_guard", "paused_by_member", "removed"];

export function nextStatusAfterGuard(status: BindingStatus, captureOk: boolean): { status: BindingStatus; paused: boolean } {
  if (status === "active" && !captureOk) return { status: "paused_guard", paused: true };
  return { status, paused: false };
}

export type ResumeVerdict = { ok: true } | { ok: false; reason: "not_paused" | "guard_failed" | "booting_member_present" };

export function canResume(input: {
  status: BindingStatus;
  captureOk: boolean;
  bootedBy: string | null;
  bootConsent: boolean;
  bootingMemberPresent: boolean;
}): ResumeVerdict {
  if (input.status !== "paused_guard" && input.status !== "paused_by_member") return { ok: false, reason: "not_paused" };
  if (input.status === "paused_by_member" && input.bootedBy && !input.bootConsent && input.bootingMemberPresent) {
    return { ok: false, reason: "booting_member_present" };
  }
  if (!input.captureOk) return { ok: false, reason: "guard_failed" };
  return { ok: true };
}

export type BootVerdict = { ok: true; noop: boolean } | { ok: false; reason: "general_channel" | "not_member" | "not_bound" };

/** Anyone in the conversation may boot it, except a general channel (admin only). */
export function canBoot(input: { status: BindingStatus; isGeneral: boolean; isAdmin: boolean; isMember: boolean }): BootVerdict {
  if (input.status === "removed") return { ok: false, reason: "not_bound" };
  if (input.status === "paused_by_member") return { ok: true, noop: true };
  if (input.isGeneral && !input.isAdmin) return { ok: false, reason: "general_channel" };
  if (!input.isMember && !input.isAdmin) return { ok: false, reason: "not_member" };
  return { ok: true, noop: false };
}
