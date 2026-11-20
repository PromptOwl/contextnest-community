/**
 * Team chat in this nest (PO-1200, AC-C3-19), in the nest's settings: the
 * nest's own switch (owner or admin; the server switch stays the superadmin's
 * under Settings → Features), and the caller's default notification level
 * here. Acts on its own: each change saves at once, not through Save. Hidden
 * while the server switch is off (the settings route answers 404 then).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, MessagesSquare } from "lucide-react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import * as api from "../../lib/api";
import { LEVELS, type NotifyLevel } from "../../lib/chat-live";
import { keys, reads } from "../../lib/queries";

export function NestChatPanel({ nestId, canManage }: { nestId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const settings = useQuery({ ...reads.chatSettings(nestId), retry: false });
  const prefs = useQuery({ ...reads.chatPreferences(), retry: false, enabled: settings.data?.chat === true });
  if (!settings.data) return null;
  const on = settings.data.chat;
  const mine: NotifyLevel = prefs.data?.nests.find((n) => n.nest_id === nestId)?.level ?? prefs.data?.default ?? "mentions";

  const toggle = async (next: boolean) => {
    try {
      await api.setChatSettings(nestId, next);
      await Promise.all([qc.invalidateQueries({ queryKey: keys.chatSettings(nestId) }), qc.invalidateQueries({ queryKey: keys.nest(nestId) })]);
      toast.success(next ? "Team chat is on in this nest" : "Team chat is off in this nest");
    } catch (e) {
      toast.error((e as Error | undefined)?.message || "Could not change team chat");
    }
  };
  const setLevel = async (level: NotifyLevel) => {
    try {
      await api.setChatPreference({ nest_id: nestId, level });
      await qc.invalidateQueries({ queryKey: keys.chatPreferences() });
    } catch (e) {
      toast.error((e as Error | undefined)?.message || "Could not change notifications");
    }
  };

  return (
    <div className="space-y-3 rounded-lg border p-4" data-testid="nest-chat-panel">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor="nest-chat-switch" className="flex items-center gap-2 text-sm font-medium">
            <MessagesSquare className="h-4 w-4" />
            Team chat
          </Label>
          <p className="text-xs text-muted-foreground">
            Channels, direct messages and threads for the people added to this nest and their agents, beside its documents. Off hides chat here for everyone;
            messages are kept and come back when it is turned on again.
          </p>
        </div>
        <Switch id="nest-chat-switch" checked={on} onCheckedChange={(v) => void toggle(v)} disabled={!canManage} aria-label="Team chat in this nest" data-testid="nest-chat-switch" />
      </div>
      {on && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <Label className="flex items-center gap-2 text-xs font-medium">
            <Bell className="h-3.5 w-3.5" />
            Notify me here about
          </Label>
          <Select value={mine} onValueChange={(v) => void setLevel(v as NotifyLevel)}>
            <SelectTrigger className="h-8 w-44 text-xs" aria-label="Notify me in this nest about" data-testid="nest-chat-level">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEVELS.map((l) => (
                <SelectItem key={l.level} value={l.level} className="text-xs">
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="w-full text-xs text-muted-foreground">Your default for every channel and conversation here; each one can override it from its own menu.</p>
        </div>
      )}
    </div>
  );
}
