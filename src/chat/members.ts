/**
 * Channel membership (team chat harness C2, PO-1197): private channels, and
 * the member list of a public one — on the node's existing shares.
 *
 * A PRIVATE channel is an ordinary channel node carrying the `#private` tag;
 * its member list is the node's `grants` rows (document shares, role read),
 * so nothing is stored anywhere new. While the tag is on, the access guard
 * admits members only: non-members get the same 404 as for a channel that
 * doesn't exist, and no listing, search, feed, mention, card or promote
 * names it (containers.ts, access-guard.ts). A PUBLIC channel's member list
 * is informational — who joined — and restricts nothing.
 *
 * WHO:
 *   create private   a nest writer (as any channel), who becomes its first member;
 *   invite           a nest writer, or any member of the channel (a read
 *                    collaborator included) — so a team can grow its own room;
 *   join             anyone added to the nest, on a PUBLIC channel only (a
 *                    private one is 404 to them);
 *   leave            any member; the last member of a private channel can't
 *                    (409: archive it instead), or it would be nobody's;
 *   make public /    the nest's owner or an admin who can read the channel
 *   private          (so, on a private one, a member). Making a public
 *                    channel private puts the caller on its list, next to
 *                    whoever had joined.
 */
import { config } from "../config.js";
import { resolveNestAccess } from "../shared/access.js";
import { canCreateInNest } from "../governance/stewardship-service.js";
import { normalizeTag } from "../governance/tag-index-service.js";
import { updateNode } from "../nodes/service.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { getReadableChannel, isNestMember, type ChannelView } from "../channels/channel-service.js";
import { tagsOf } from "../channels/channel-node.js";
import { emitChatEvent } from "./events.js";
import {
  addAgentMember,
  addPersonMember,
  assertRoom,
  isContainerMember,
  isPrivateContainer,
  listPeople,
  memberViews,
  PRIVATE_TAG,
  removePersonMember,
  resolveMemberSpecs,
  type MemberView,
} from "./containers.js";

interface Caller {
  nestId: string;
  userId: string;
  userEmail: string;
  crossNest?: boolean;
}

export interface ChannelMembers {
  channel: string;
  private: boolean;
  members: MemberView[];
}

/** On create: the creator joins their channel (a read share on the node). The
 *  #private tag itself is written with the node (channel-service). */
export async function recordChannelCreator(nestId: string, nodeId: string, creator: { userId: string; userEmail: string }): Promise<void> {
  await addPersonMember(nestId, nodeId, { email: creator.userEmail, userId: creator.userId }, creator.userEmail);
}

async function isNestAdmin(nestId: string, userId: string): Promise<boolean> {
  if (config.AUTH_MODE === "open") return true;
  const p = (await resolveNestAccess(nestId, userId)).permission;
  return p === "owner" || p === "admin";
}

/** People added to the nest only: a share on the channel node (which reads
 *  its threads through the node routes) does not read who joined. */
async function nestMember(caller: Caller): Promise<void> {
  if (!(await isNestMember(caller.nestId, caller.userId))) throw new NotFoundError("Channel not found");
}

export async function listChannelMembers(caller: Caller, rawName: unknown): Promise<ChannelMembers> {
  await nestMember(caller);
  const { node } = await getReadableChannel(caller, rawName);
  return { channel: node.id, private: await isPrivateContainer(caller.nestId, node.id), members: await memberViews(caller.nestId, node.id, node) };
}

/** Invite a person added to the nest (or a known agent): a writer, or a member of the channel. */
export async function inviteChannelMember(caller: Caller, rawName: unknown, member: unknown): Promise<ChannelMembers> {
  await nestMember(caller);
  const { node } = await getReadableChannel(caller, rawName);
  const mayInvite = (await isContainerMember(caller.nestId, node.id, caller.userId)) || (await canCreateInNest(caller.nestId, caller.userEmail));
  if (!mayInvite) throw new ForbiddenError("Inviting to a channel is for its members and the nest's writers.");
  if (typeof member !== "string" || !member.trim()) throw new ValidationError("member is required — a name, an email or an @handle.");
  const { people, agents } = await resolveMemberSpecs(caller.nestId, [member]);
  if (await isPrivateContainer(caller.nestId, node.id)) await assertRoom(caller.nestId, node.id);
  const me = caller.userEmail.toLowerCase();
  let added: string | null = null;
  for (const p of people) if (await addPersonMember(caller.nestId, node.id, p, me)) added = p.email;
  for (const h of agents) if (await addAgentMember(caller.nestId, node.id, h, me)) added = `@${h}`;
  if (added) emitChatEvent(caller.nestId, { type: "membership.changed", conversation: node.id, action: "added", member: added, by: me });
  return listChannelMembers(caller, node.id);
}

/** Join a public channel (a private one is not found to a non-member). */
export async function joinChannel(caller: Caller, rawName: unknown): Promise<{ channel: ChannelView }> {
  await nestMember(caller);
  const { node } = await getReadableChannel(caller, rawName);
  const me = caller.userEmail.toLowerCase();
  if (await addPersonMember(caller.nestId, node.id, { email: me, userId: caller.userId }, me)) {
    emitChatEvent(caller.nestId, { type: "membership.changed", conversation: node.id, action: "added", member: me, by: me });
  }
  return { channel: (await getReadableChannel(caller, node.id)).view };
}

export async function leaveChannel(caller: Caller, rawName: unknown): Promise<{ left: true; channel: string }> {
  await nestMember(caller);
  const { node } = await getReadableChannel(caller, rawName);
  const me = caller.userEmail.toLowerCase();
  if (await isPrivateContainer(caller.nestId, node.id)) {
    const people = await listPeople(caller.nestId, node.id);
    if (people.length <= 1 && people.some((m) => m.user_id === caller.userId)) {
      throw new ConflictError("You are the last member of this private channel. Invite someone first, or archive it.");
    }
  }
  await removePersonMember(caller.nestId, node.id, caller.userId);
  emitChatEvent(caller.nestId, { type: "membership.changed", conversation: node.id, action: "left", member: me, by: me });
  return { left: true, channel: node.id };
}

/** Make a channel private (members only) or public again. Owner/admin who can read it. */
export async function setChannelPrivate(caller: Caller, rawName: unknown, priv: unknown): Promise<{ channel: ChannelView }> {
  if (typeof priv !== "boolean") throw new ValidationError("private must be a boolean");
  await nestMember(caller);
  const { node } = await getReadableChannel(caller, rawName);
  if (!(await isNestAdmin(caller.nestId, caller.userId))) throw new ForbiddenError("Only the nest's owner or an admin can make a channel private or public.");
  const me = caller.userEmail.toLowerCase();
  const was = await isPrivateContainer(caller.nestId, node.id);
  if (priv && !was) {
    // The caller joins first, so the channel is never nobody's; then the tag.
    await addPersonMember(caller.nestId, node.id, { email: me, userId: caller.userId }, me);
    await updateNode(caller.nestId, node.id, { tags: [...tagsOf(node), `#${PRIVATE_TAG}`], changeNote: "Made the channel private" }, me, { chatMembership: true });
    emitChatEvent(caller.nestId, { type: "membership.changed", conversation: node.id, action: "private", member: null, by: me });
  } else if (!priv && was) {
    // Members stay listed (as on a public channel); the tag that gated reads goes.
    await updateNode(caller.nestId, node.id, { tags: tagsOf(node).filter((t) => normalizeTag(t) !== PRIVATE_TAG), changeNote: "Made the channel public" }, me, { chatMembership: true });
    emitChatEvent(caller.nestId, { type: "membership.changed", conversation: node.id, action: "public", member: null, by: me });
  }
  return { channel: (await getReadableChannel(caller, node.id)).view };
}
