/** The open channel's name and purpose, with archive (or restore) for people who manage channels. */
import { Archive, ArchiveRestore } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { OverflowMenu } from "@/components/ui/overflow-menu";
import type { ChannelSummary } from "../../lib/api";

export function ChannelHeader({
  channel,
  canManage,
  onArchive,
  onRestore,
}: {
  channel: ChannelSummary;
  canManage: boolean;
  onArchive: () => void;
  onRestore: () => void;
}) {
  return (
    <header className="flex items-start justify-between gap-3 border-b pb-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="truncate text-lg font-semibold tracking-tight">{channel.title}</h2>
          {channel.archived && <Badge variant="neutral">Archived</Badge>}
        </div>
        {channel.purpose && (
          <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted-foreground [overflow-wrap:anywhere]">{channel.purpose}</p>
        )}
      </div>
      {canManage &&
        (channel.archived ? (
          <Button size="sm" variant="outline" onClick={onRestore} className="shrink-0">
            <ArchiveRestore className="mr-1.5 h-3.5 w-3.5" /> Restore
          </Button>
        ) : (
          <OverflowMenu
            className="h-8 w-8 shrink-0"
            triggerTitle="Channel actions"
            testId="channel-actions"
            actions={[{ label: "Archive channel", icon: Archive, onSelect: onArchive, testId: "channel-archive" }]}
          />
        ))}
    </header>
  );
}
