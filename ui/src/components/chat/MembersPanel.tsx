/**
 * The members panel (PO-1200, AC-C3-16): who is in this channel or
 * conversation, who of them is around now, and "Add people" for those who
 * may invite. A public channel is open to everyone on the nest; its list is
 * who joined, then who else can read it. Opens as a sheet from the right at every width.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Lock, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import * as api from "../../lib/api";
import { memberRows, memberSpec, membersSummary, type MemberRow } from "../../lib/chat-harness";
import { reads } from "../../lib/queries";
import type { MentionMember } from "../MarkdownEditor/picker-match";
import { ChatSheet, SheetClose } from "./ChatSheet";
import { MemberAvatar, PeoplePicker, pickKey, type Candidate } from "./Presence";
import { ErrorState } from "./States";

function MemberList({ rows, testId }: { rows: MemberRow[]; testId: string }) {
  return (
    <ul data-testid={testId}>
      {rows.map((r) => (
        <li key={r.key} className="flex h-11 items-center gap-2.5 rounded-md px-2" data-testid="member-row">
          <MemberAvatar kind={r.kind} label={r.label} email={r.email} online={r.online} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">
              {r.label}
              {r.you && <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>}
            </span>
            <span className="block truncate text-xs text-muted-foreground">{r.kind === "agent" ? "Agent" : r.online ? "Around now" : r.email}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function MembersPanel({
  open,
  onOpenChange,
  nestId,
  channel,
  me,
  online,
  people,
  agents,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nestId: string;
  channel: api.ChannelSummary;
  me: string | null;
  online: ReadonlySet<string>;
  people: MentionMember[];
  agents: api.AgentHandle[];
  /** Rejects with the server's message. */
  onAdd: (member: string) => Promise<void>;
}) {
  const conv = channel.conversation;
  const members = useQuery({
    ...reads.containerMembers(nestId, channel.name, async () => (conv ? { members: conv.members } : api.listChannelMembers(nestId, channel.name))),
    enabled: open,
  });
  const rows = useMemo(() => memberRows(members.data?.members ?? [], online, me), [members.data, online, me]);
  const others = useMemo(
    () => memberRows((members.data?.audience ?? []).map((p) => ({ kind: "person", ...p, added_at: "" })), online, me),
    [members.data, online, me],
  );
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const inList = useMemo(() => new Set(rows.map((r) => r.key)), [rows]);
  // A dm is two people by definition; the server refuses to grow one.
  const canAdd = !channel.archived && channel.can_post && conv?.kind !== "dm";

  const add = async () => {
    if (!picked.length) return;
    setBusy(true);
    try {
      for (const c of picked) await onAdd(memberSpec(c));
      toast.success(picked.length === 1 ? "Added" : `Added ${picked.length}`);
      setPicked([]);
      setAdding(false);
      await members.refetch();
    } catch (e) {
      toast.error((e as Error | undefined)?.message || "Could not add them");
    } finally {
      setBusy(false);
    }
  };

  const title = conv ? (conv.kind === "dm" ? "In this conversation" : "In this group") : `Members of #${channel.name}`;

  return (
    <ChatSheet open={open} onOpenChange={onOpenChange} side="right" title={title} width="min(100vw, 24rem)" testId="chat-members">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
        <SheetClose />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {!conv && (
          <p className="flex items-start gap-2 px-2 pb-3 text-xs text-muted-foreground">
            {channel.private ? (
              <>
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> Private: only the people below can find and read it.
              </>
            ) : (
              <>Everyone added to this nest can read and post here, whether or not they joined.</>
            )}
          </p>
        )}
        {members.isError ? (
          <ErrorState title="Couldn't load the members" detail={(members.error as Error)?.message ?? null} onRetry={() => void members.refetch()} className="m-2" />
        ) : members.isLoading ? (
          <div className="space-y-2 px-2" aria-busy>
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-2.5">
                <span className="h-8 w-8 animate-pulse rounded-md bg-muted" />
                <span className="h-3 w-32 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : (
          <>
            <p className="px-2 pb-1 text-xs font-semibold text-muted-foreground">
              {membersSummary(rows, others)}
            </p>
            <MemberList rows={rows} testId="member-list" />
            {others.length > 0 && (
              <>
                <p className="px-2 pb-1 pt-3 text-xs font-semibold text-muted-foreground">Also have access ({others.length})</p>
                <MemberList rows={others} testId="member-audience" />
              </>
            )}
          </>
        )}

        {canAdd && (
          <div className="mt-3 border-t px-2 pt-3">
            {adding ? (
              <div className="space-y-3">
                <PeoplePicker people={people} agents={agents} me={me} exclude={inList} picked={picked} onToggle={(c) => setPicked((cur) => (cur.some((x) => pickKey(x) === pickKey(c)) ? cur.filter((x) => pickKey(x) !== pickKey(c)) : [...cur, c]))} autoFocus testId="member-add-picker" />
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => (setAdding(false), setPicked([]))} disabled={busy}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={() => void add()} disabled={busy || picked.length === 0} data-testid="member-add-confirm">
                    {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                    Add {picked.length > 1 ? picked.length : ""}
                  </Button>
                </div>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setAdding(true)} data-testid="member-add">
                <UserPlus className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Add people
              </Button>
            )}
          </div>
        )}
      </div>
    </ChatSheet>
  );
}
