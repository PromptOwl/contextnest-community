/**
 * The C1 message features wired to the rows (PO-1200 AC-C3-12): the extra
 * actions a message offers (react, edit, delete, pin, save) and what is drawn
 * under its body (reactions). One hook, used by the page and the slide-over,
 * so a post in the conversation and a reply in the thread behave the same.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Bookmark, BookmarkCheck, Pencil, Pin, PinOff, SmilePlus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "../../auth/AuthContext";
import type { ChannelMessage, ChannelPost, ChannelSummary, PostedMention } from "../../lib/api";
import { mentionNotice } from "../../lib/channels";
import { broadcastNotice, canDelete, canEdit } from "../../lib/chat-messages";
import { ReasonDialog } from "../governance";
import type { MessageAction } from "./MessageRow";
import { ReactionBar, ReactionPicker } from "./Reactions";
import type { ChannelsData } from "./useChannels";

type AnyMessage = ChannelMessage | ChannelPost;

const fail = (fallback: string) => (e: unknown) => {
  toast.error((e as Error | undefined)?.message || fallback);
};

/** The toasts after a post or an edit: names that reached nobody, agents
 *  with no wake-up, and how many a @channel reached. */
export function noticeMentions(outcomes: PostedMention[] | undefined) {
  const note = mentionNotice(outcomes);
  if (note) toast.warning(note);
  const reach = broadcastNotice(outcomes);
  if (reach) toast.success(reach);
}

export function useMessageExtras(input: { channel: ChannelSummary | null; actions: ChannelsData["actions"]; permission: string | null | undefined }) {
  const { adminStatus } = useAuth();
  const me = adminStatus?.me?.email ?? null;
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AnyMessage | null>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const { channel, actions, permission } = input;
  const canWrite = !!channel?.can_post;

  const extraActions = useCallback(
    (m: AnyMessage): MessageAction[] => {
      if (!channel || m.deleted) return [];
      const out: MessageAction[] = [];
      if (canWrite) out.push({ id: "react", label: "Add a reaction", icon: SmilePlus, onSelect: () => setPickerFor(m.id) });
      if (canWrite)
        out.push(
          m.pinned
            ? { id: "unpin", label: "Unpin", icon: PinOff, onSelect: () => void actions.setPinned(m, false).catch(fail("Could not unpin the message")) }
            : { id: "pin", label: "Pin to channel", icon: Pin, onSelect: () => void actions.setPinned(m, true).catch(fail("Could not pin the message")) },
        );
      out.push(
        m.saved
          ? { id: "unsave", label: "Unsave", icon: BookmarkCheck, active: true, onSelect: () => void actions.setSaved(m, false).catch(fail("Could not unsave the message")) }
          : { id: "save", label: "Save for later", icon: Bookmark, onSelect: () => void actions.setSaved(m, true).catch(fail("Could not save the message")) },
      );
      if (canWrite && canEdit(m, me)) out.push({ id: "edit", label: "Edit", icon: Pencil, onSelect: () => setEditing(m.id) });
      if (canWrite && canDelete(m, me, permission)) out.push({ id: "delete", label: "Delete", icon: Trash2, destructive: true, onSelect: () => setDeleting(m) });
      return out;
    },
    [channel, canWrite, me, permission, actions],
  );

  const renderUnder = useCallback(
    (m: AnyMessage): ReactNode => (
      <>
        <ReactionBar reactions={m.reactions} canReact={canWrite} onToggle={(emoji) => void actions.react(m, emoji).catch(fail("Could not react"))} />
        {pickerFor === m.id && (
          <ReactionPicker
            open
            onOpenChange={(o) => !o && setPickerFor(null)}
            className="sr-only"
            onPick={(emoji) => {
              setPickerFor(null);
              void actions.react(m, emoji).catch(fail("Could not react"));
            }}
          />
        )}
      </>
    ),
    [canWrite, actions, pickerFor],
  );

  const rowProps = useCallback(
    (m: AnyMessage) => ({
      editing: editing === m.id,
      onSaveEdit: async (body: string) => {
        try {
          noticeMentions(await actions.edit(m, body));
          setEditing(null);
        } catch (e) {
          fail("Could not save the edit")(e);
        }
      },
      onCancelEdit: () => setEditing(null),
    }),
    [editing, actions],
  );

  const dialogs = useMemo(
    () => (
      <ReasonDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this message?"
        description={deleting && !canEdit(deleting, me) ? "It will be removed for everyone and marked as removed by a moderator. Replies stay." : "It will be removed for everyone. Replies stay."}
        confirmLabel="Delete message"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await actions.remove(deleting);
          } catch (e) {
            fail("Could not delete the message")(e);
          }
        }}
      />
    ),
    [deleting, me, actions],
  );

  return { extraActions, renderUnder, rowProps, dialogs, me };
}
