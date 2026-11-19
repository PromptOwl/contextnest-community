/**
 * The header's controls for the open channel or conversation (PO-1200,
 * AC-C3-16, AC-C3-17): who is in it, and one menu for the rest —
 * notifications (every message, mentions only, muted), join or leave,
 * private or public, archive or restore. What the menu offers is
 * `channelMenu`; each item calls the C2 route behind it.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Bell, BellOff, Globe, Lock, LogIn, LogOut, Settings2, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import * as api from "../../lib/api";
import { channelMenu } from "../../lib/chat-harness";
import { LEVELS, levelFor, type NotifyLevel } from "../../lib/chat-live";
import { keys, reads } from "../../lib/queries";

const fail = (fallback: string) => (e: unknown) => {
  toast.error((e as Error | undefined)?.message || fallback);
};

export function MembersButton({ count, onClick }: { count: number | null; onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} className="h-8 shrink-0 gap-1.5 px-2 text-muted-foreground hover:text-foreground" title="Members" aria-label="Members" data-testid="chat-members-open">
      <Users className="h-4 w-4" aria-hidden />
      {count !== null && <span className="text-xs tabular-nums">{count}</span>}
    </Button>
  );
}

export function useNotifyLevel(nestId: string, containerNodeId: string | null) {
  const qc = useQueryClient();
  const prefs = useQuery({ ...reads.chatPreferences(), retry: false });
  const level: NotifyLevel = containerNodeId ? levelFor(prefs.data, nestId, containerNodeId) : "mentions";
  const set = async (next: NotifyLevel) => {
    if (!containerNodeId) return;
    await api.setChatPreference({ nest_id: nestId, conversation: containerNodeId, level: next });
    await qc.invalidateQueries({ queryKey: keys.chatPreferences() });
  };
  return { level, set, loaded: !!prefs.data };
}

export function ChannelMenu({
  nestId,
  channel,
  nodeId,
  canManage,
  isAdmin,
  onMembers,
  onJoin,
  onLeave,
  onSetPrivate,
  onArchive,
  onRestore,
}: {
  nestId: string;
  channel: api.ChannelSummary;
  nodeId: string;
  canManage: boolean;
  isAdmin: boolean;
  onMembers: () => void;
  onJoin: () => Promise<void>;
  onLeave: () => void;
  onSetPrivate: (to: boolean) => Promise<void>;
  onArchive?: () => void;
  onRestore?: () => void;
}) {
  const items = channelMenu(channel, { canManage, isAdmin });
  const notify = useNotifyLevel(nestId, nodeId);
  const has = (i: (typeof items)[number]) => items.includes(i);
  const muted = notify.level === "none";

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground" title={channel.conversation ? "Conversation settings" : "Channel settings"} aria-label={channel.conversation ? "Conversation settings" : "Channel settings"} data-testid="channel-actions">
          {muted ? <BellOff className="h-4 w-4" aria-hidden /> : <Settings2 className="h-4 w-4" aria-hidden />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {has("notifications") && (
          <>
            <DropdownMenuLabel className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
              <Bell className="h-3.5 w-3.5" aria-hidden /> Notify me about
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={notify.level}
              onValueChange={(v) =>
                void notify
                  .set(v as NotifyLevel)
                  .then(() => toast.success(v === "none" ? "Muted. Unread counts still show." : v === "all" ? "You'll hear about every message." : "Only @mentions will ping you."))
                  .catch(fail("Could not change notifications"))
              }
            >
              {LEVELS.map((l) => (
                <DropdownMenuRadioItem key={l.level} value={l.level} className="items-start py-1.5" data-testid={`notify-${l.level}`}>
                  <span className="flex flex-col">
                    <span className="text-sm">{l.label}</span>
                    <span className="text-xs text-muted-foreground">{l.detail}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        )}
        {has("members") && (
          <DropdownMenuItem onSelect={onMembers} className="gap-2">
            <Users className="h-4 w-4 text-muted-foreground" aria-hidden /> Members
          </DropdownMenuItem>
        )}
        {has("join") && (
          <DropdownMenuItem onSelect={() => void onJoin().then(() => toast.success(`Joined #${channel.name}`)).catch(fail("Could not join"))} className="gap-2" data-testid="channel-join">
            <LogIn className="h-4 w-4 text-muted-foreground" aria-hidden /> Join channel
          </DropdownMenuItem>
        )}
        {has("make-private") && (
          <DropdownMenuItem onSelect={() => void onSetPrivate(true).then(() => toast.success(`#${channel.name} is private now`)).catch(fail("Could not make it private"))} className="gap-2" data-testid="channel-make-private">
            <Lock className="h-4 w-4 text-muted-foreground" aria-hidden /> Make private
          </DropdownMenuItem>
        )}
        {has("make-public") && (
          <DropdownMenuItem onSelect={() => void onSetPrivate(false).then(() => toast.success(`#${channel.name} is open to the nest now`)).catch(fail("Could not make it public"))} className="gap-2" data-testid="channel-make-public">
            <Globe className="h-4 w-4 text-muted-foreground" aria-hidden /> Make public
          </DropdownMenuItem>
        )}
        {has("leave") && (
          <DropdownMenuItem onSelect={onLeave} className="gap-2" data-testid="channel-leave">
            <LogOut className="h-4 w-4 text-muted-foreground" aria-hidden /> {channel.conversation ? "Leave conversation" : "Leave channel"}
          </DropdownMenuItem>
        )}
        {has("archive") && onArchive && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onArchive} className="gap-2 text-destructive focus:text-destructive" data-testid="channel-archive">
              <Archive className="h-4 w-4" aria-hidden /> Archive channel
            </DropdownMenuItem>
          </>
        )}
        {has("restore") && onRestore && (
          <DropdownMenuItem onSelect={onRestore} className="gap-2">
            <ArchiveRestore className="h-4 w-4 text-muted-foreground" aria-hidden /> Restore channel
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
