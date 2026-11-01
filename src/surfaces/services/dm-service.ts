/**
 * DM to a private nest (PRD AC-DM-*, §12 R1/R2).
 *
 *  - DM capture is an admin setting, default OFF. While off, a DM is never
 *    buffered and the bot answers at most once per person per 7 days that
 *    it's off and who can turn it on (AC-DMS-01).
 *  - Turning it off purges every DM buffer in the same transaction as the
 *    setting, withdraws pending DM cards (no hold) and is audit-logged with
 *    the admin's identity (AC-DMS-02).
 *  - A person can turn their own DM capture off (App Home toggle or
 *    `/nest dm off`): their DM buffer is purged and pending DM cards
 *    withdrawn (AC-DMS-03).
 *  - An unlinked person gets a one-time link and nothing is buffered
 *    (AC-DM-05). A linked person's first DM makes "<Name> (private)", owned
 *    by them, and binds the DM through the normal guard: EffectiveReaders
 *    must be exactly {them} (server admins excluded and disclosed, R1).
 *    If it can't be, capture is refused and nothing is buffered (AC-DM-06).
 *  - No folders are created (Project November, §14): until a seed is applied
 *    (S3, `surfaces.default_seed`) the listener has none, so DM windows end
 *    `no_target_folder` and the counts-only alert goes to the OWNER (the nest
 *    is sealed), not to admins.
 */
import { getDb } from "../../db/client.js";
import { createNest } from "../../nests/service.js";
import { ORG_ID } from "../flags.js";
import { getConnector } from "../registry.js";
import { PRIVATE_NEST_DISCLOSURE } from "../core/card-model.js";
import { DM_REFUSED, GuardRefusedError, getBindingRow, type BindingRow } from "./binding-service.js";
import { installRef, type InstallRow } from "./install-store.js";
import { issueLinkToken, linkUrl, resolveIdentity } from "./identity-service.js";
import { createBindingWithListener } from "./listener-service.js";
import { getSettings, updateSettings } from "./settings-service.js";
import { recordNotice } from "./notices.js";
import { withdrawBindingCards } from "./expiry-service.js";
import type { SurfaceSettings } from "../core/settings.js";

export const DM_NOTICE_EVERY_MS = 7 * 24 * 3600_000;
export const DM_OFF_NOTE =
  "Nest isn't keeping anything from direct messages here: DM capture is off for this workspace. A server administrator can turn it on in Surfaces settings. Nothing from this message was kept.";
export const DM_PERSONAL_OFF_NOTE = "Your DM capture is off, so Nest didn't keep this. Turn it back on from Nest's Home tab or with `/nest dm on`.";
export const dmIntro = (nest: string) => `I made you a private nest, ${nest}, for what you ask me to remember here. ${PRIVATE_NEST_DISCLOSURE}`;
export const dmLinkNote = (url: string) => `To keep things from our DMs, link your ContextNest account first (the link works once, for 15 minutes): <${url}|Link my account>. Nothing from this message was kept.`;

const iso = (ms = Date.now()) => new Date(ms).toISOString();

async function direct(install: InstallRow, user: string, text: string, channel: string | null): Promise<void> {
  const c = getConnector(install.surface);
  if (!c?.sendDirect) return;
  try {
    await c.sendDirect(installRef(install), user, text, channel);
  } catch {
    /* best effort */
  }
}

export async function personalDmOff(installId: string, surfaceUserId: string): Promise<boolean> {
  return !!(await getDb().get("SELECT 1 AS x FROM surface_dm_optouts WHERE install_id = ? AND surface_user_id = ?", [installId, surfaceUserId]));
}

/** At most once per person per 7 days; the claim is a compare-and-set. */
async function noticeDue(installId: string, user: string, kind: string, nowMs = Date.now()): Promise<boolean> {
  const r = await getDb().run(
    `INSERT INTO surface_dm_notices (install_id, surface_user_id, kind, sent_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (install_id, surface_user_id, kind) DO UPDATE SET sent_at = excluded.sent_at WHERE surface_dm_notices.sent_at <= ?`,
    [installId, user, kind, iso(nowMs), iso(nowMs - DM_NOTICE_EVERY_MS)],
  );
  return r.changes > 0;
}

async function personalNest(install: InstallRow, userId: string): Promise<string> {
  const row = (await getDb().get("SELECT nest_id FROM surface_personal_nests WHERE install_id = ? AND community_user_id = ?", [install.id, userId])) as
    | { nest_id: string }
    | undefined;
  if (row && (await getDb().get("SELECT 1 AS x FROM nests WHERE id = ?", [row.nest_id]))) return row.nest_id;
  const u = (await getDb().get("SELECT name, email FROM users WHERE id = ?", [userId])) as { name: string | null; email: string };
  const name = `${(u.name?.trim() || u.email.split("@")[0]).slice(0, 60)} (private)`;
  const nest = await createNest(userId, name, "Your private nest for what you ask Nest to remember in direct messages.");
  await getDb().run(
    `INSERT INTO surface_personal_nests (install_id, community_user_id, nest_id, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (install_id, community_user_id) DO UPDATE SET nest_id = excluded.nest_id`,
    [install.id, userId, nest.id, iso()],
  );
  return nest.id;
}

/**
 * Decide whether a DM may be captured. Returns the DM binding to buffer
 * into, or null (nothing is buffered; the person may have been told why).
 */
export async function prepareDm(install: InstallRow, conversation: string, author: string): Promise<BindingRow | null> {
  if (!author || author === install.bot_user_id) return null;
  const settings = await getSettings();
  if (!settings.dm_capture) {
    if (await noticeDue(install.id, author, "dm_off")) await direct(install, author, DM_OFF_NOTE, conversation);
    return null;
  }
  if (await personalDmOff(install.id, author)) return null;
  const userId = await resolveIdentity(install.id, author).catch(() => null);
  if (!userId) {
    try {
      const token = await issueLinkToken({ installId: install.id, surfaceUserId: author });
      await direct(install, author, dmLinkNote(linkUrl(token)), conversation);
    } catch {
      /* rate limited: say nothing more */
    }
    return null;
  }
  let binding = (await getDb().get("SELECT * FROM surface_bindings WHERE install_id = ? AND conversation_id = ?", [install.id, conversation])) as
    | BindingRow
    | undefined;
  if (binding && binding.status !== "removed") {
    return binding.status === "active" && binding.capture_ok && binding.dm_owner_user_id === userId ? binding : null;
  }
  const nestId = await personalNest(install, userId);
  try {
    const out = await createBindingWithListener({ actorUserId: userId, installId: install.id, conversationId: conversation, nestId });
    binding = (await getBindingRow(out.binding.id)) ?? undefined;
  } catch (err) {
    if (err instanceof GuardRefusedError) await direct(install, author, DM_REFUSED, conversation);
    return null;
  }
  if (!binding || binding.conversation_kind !== "dm" || !binding.capture_ok || !binding.surface_ok) return null;
  const nest = (await getDb().get("SELECT name FROM nests WHERE id = ?", [nestId])) as { name: string };
  await direct(install, author, dmIntro(nest.name), conversation);
  return binding;
}

async function purgeDmBindings(where: string, params: string[]): Promise<string[]> {
  const rows = (await getDb().all(`SELECT id FROM surface_bindings WHERE conversation_kind = 'dm' AND ${where}`, params)) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Settings save with its side effects (REST and MCP both use this). Turning
 * DM capture OFF purges every DM buffer in the SAME transaction as the
 * setting, then withdraws pending DM cards (no hold) and writes an audit
 * notice naming the admin.
 */
export async function updateSettingsWithEffects(patch: Record<string, unknown>, actorUserId: string): Promise<SurfaceSettings> {
  const before = await getSettings();
  const turningOff = before.dm_capture && patch.dm_capture === false;
  const turningOn = !before.dm_capture && patch.dm_capture === true;
  let next: SurfaceSettings;
  let dm: string[] = [];
  if (turningOff) {
    next = await getDb().transaction(async (tx) => {
      const saved = await updateSettings(patch, tx);
      const ids = (await tx.all("SELECT id FROM surface_bindings WHERE conversation_kind = 'dm'", [])) as Array<{ id: string }>;
      // M2: pause every live DM binding in the SAME transaction as the
      // setting, so an event already past prepareDm can't buffer into it
      // (the gate, bufferMessage and the judge all require `active`).
      await tx.run(
        `UPDATE surface_bindings SET status = 'paused_guard', pause_reason = 'dm_off', status_changed_at = ?, version = version + 1, updated_at = ?
          WHERE conversation_kind = 'dm' AND status = 'active'`,
        [iso(), iso()],
      );
      for (const { id } of ids) {
        await tx.run("DELETE FROM surface_buffer WHERE binding_id = ?", [id]);
        await tx.run(
          `UPDATE surface_windows SET status = 'discarded', close_reason = 'discarded', verdict = 'discarded', updated_at = ?
            WHERE binding_id = ? AND status IN ('open', 'awaiting_fetch', 'closing', 'judging')`,
          [iso(), id],
        );
      }
      dm = ids.map((r) => r.id);
      return saved;
    });
  } else if (turningOn) {
    next = await getDb().transaction(async (tx) => {
      const saved = await updateSettings(patch, tx);
      // Resume DM bindings this switch paused — not those whose owner opted out.
      await tx.run(
        `UPDATE surface_bindings SET status = 'active', pause_reason = NULL, guard_dirty = 1, guard_dirty_epoch = guard_dirty_epoch + 1,
           status_changed_at = ?, version = version + 1, updated_at = ?
          WHERE conversation_kind = 'dm' AND status = 'paused_guard' AND pause_reason = 'dm_off'`,
        [iso(), iso()],
      );
      return saved;
    });
  } else {
    next = await updateSettings(patch);
  }
  if (turningOff) for (const id of dm) await withdrawBindingCards(id);
  if (turningOff || turningOn) {
    await recordNotice({
      kind: "dm_capture_changed",
      audience: "admins",
      detail: { dm_capture: !!next.dm_capture, by_user_id: actorUserId, org_id: ORG_ID, dm_bindings: dm.length },
      subject: `DM capture turned ${next.dm_capture ? "on" : "off"}`,
      text: `A server administrator turned DM capture ${next.dm_capture ? "on" : "off"} for connected workspaces.${turningOff ? " Messages Nest was holding from DMs were deleted and pending DM proposals withdrawn." : ""}`,
    });
  }
  // Round 8 (Misha, 2026-11-01): an admin can't silently switch off the
  // owners' sign-in alerts — turning them off tells every sealed-nest owner.
  if (before.signin_alerts && next.signin_alerts === false) {
    const { alertSealedOwnersAlertsOff } = await import("../signin-alerts.js");
    await alertSealedOwnersAlertsOff();
  }
  return next;
}

/** Tests only: runs after prepareDm returned a binding, before the message is buffered. */
export const dmTestHooks: { afterPrepare?: () => Promise<void> | void } = {};

/**
 * May this DM binding capture right now? (M2) The judge re-checks it under
 * its window claim, and the card post re-checks it before posting.
 */
export async function dmCaptureAllowed(b: Pick<BindingRow, "conversation_kind" | "status" | "install_id" | "dm_owner_user_id">): Promise<boolean> {
  if (b.conversation_kind !== "dm") return true;
  if (b.status !== "active") return false;
  if (!(await getSettings()).dm_capture) return false;
  if (!b.dm_owner_user_id) return false;
  const out = await getDb().get(
    `SELECT 1 AS x FROM surface_dm_optouts o JOIN surface_identity_links l
        ON l.install_id = o.install_id AND l.surface_user_id = o.surface_user_id AND l.status = 'active'
      WHERE o.install_id = ? AND l.community_user_id = ?`,
    [b.install_id, b.dm_owner_user_id],
  );
  return !out;
}

/**
 * A person turns their own DM capture off / on (App Home toggle,
 * `/nest dm off|on`). Off: the opt-out row, the pause of their DM bindings
 * and the purge of their DM buffer happen in ONE transaction (M2); pending DM
 * cards are then withdrawn. On: their bindings resume (unless DM capture is
 * off for everyone, in which case they stay paused for that reason).
 */
export async function setPersonalDm(install: InstallRow, surfaceUserId: string, on: boolean): Promise<void> {
  const userId = await resolveIdentity(install.id, surfaceUserId).catch(() => null);
  if (on) {
    const globalOn = (await getSettings()).dm_capture;
    await getDb().transaction(async (tx) => {
      await tx.run("DELETE FROM surface_dm_optouts WHERE install_id = ? AND surface_user_id = ?", [install.id, surfaceUserId]);
      if (!userId) return;
      await tx.run(
        globalOn
          ? `UPDATE surface_bindings SET status = 'active', pause_reason = NULL, guard_dirty = 1, guard_dirty_epoch = guard_dirty_epoch + 1, status_changed_at = ?,
               version = version + 1, updated_at = ? WHERE install_id = ? AND conversation_kind = 'dm' AND dm_owner_user_id = ? AND status = 'paused_guard' AND pause_reason = 'dm_optout'`
          : `UPDATE surface_bindings SET pause_reason = 'dm_off', status_changed_at = ?, updated_at = ?
               WHERE install_id = ? AND conversation_kind = 'dm' AND dm_owner_user_id = ? AND status = 'paused_guard' AND pause_reason = 'dm_optout'`,
        [iso(), iso(), install.id, userId],
      );
    });
    return;
  }
  // No linked user → no DM binding of theirs (a NUL placeholder would be
  // rejected by Postgres text parameters).
  const ids = userId ? await purgeDmBindings("install_id = ? AND dm_owner_user_id = ?", [install.id, userId]) : [];
  await getDb().transaction(async (tx) => {
    await tx.run("INSERT INTO surface_dm_optouts (install_id, surface_user_id, created_at) VALUES (?, ?, ?) ON CONFLICT (install_id, surface_user_id) DO NOTHING", [
      install.id,
      surfaceUserId,
      iso(),
    ]);
    for (const id of ids) {
      await tx.run(
        `UPDATE surface_bindings SET status = 'paused_guard', pause_reason = 'dm_optout', status_changed_at = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND status = 'active'`,
        [iso(), iso(), id],
      );
      await tx.run("DELETE FROM surface_buffer WHERE binding_id = ?", [id]);
      await tx.run(
        `UPDATE surface_windows SET status = 'discarded', close_reason = 'discarded', verdict = 'discarded', updated_at = ?
          WHERE binding_id = ? AND status IN ('open', 'awaiting_fetch', 'closing', 'judging')`,
        [iso(), id],
      );
    }
    // Their DM rows by author too, in case no binding maps.
    await tx.run(
      "DELETE FROM surface_buffer WHERE install_id = ? AND author_surface_user_id = ? AND binding_id IN (SELECT id FROM surface_bindings WHERE conversation_kind = 'dm')",
      [install.id, surfaceUserId],
    );
  });
  for (const id of ids) await withdrawBindingCards(id);
}
