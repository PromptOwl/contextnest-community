/**
 * StewardList — ported from packages/ui-components/src/stewardship/StewardList.tsx
 * Adapted: uses onRemove callback prop instead of PromptOwl server-action import.
 */
import React, { useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Loader2,
  MoreVertical,
  Trash2,
  Shield,
  Tag,
  FileText,
  Building2,
  UserPlus,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type StewardshipScope = "document" | "tag" | "nest";

export interface Steward {
  id: string;
  userEmail: string;
  userId?: string;
  scope: StewardshipScope;
  tagName?: string;
  nodePattern?: string;
  nodeTitle?: string;
  role: "editor" | "reviewer" | "viewer";
}

interface StewardListProps {
  stewards: Steward[];
  loading?: boolean;
  showScope?: boolean;
  className?: string;
  onAddSteward?: () => void;
  onRemove?: (stewardId: string) => Promise<void>;
  compact?: boolean;
}

const scopeConfig: Record<StewardshipScope, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  document: { label: "Document", icon: FileText },
  tag: { label: "Tag", icon: Tag },
  nest: { label: "Nest", icon: Building2 },
};

export function StewardList({
  stewards,
  loading = false,
  showScope = false,
  className,
  onAddSteward,
  onRemove,
  compact = false,
}: StewardListProps) {
  const [removingId, setRemovingId] = useState<string | null>(null);

  const handleRemove = async (stewardId: string) => {
    if (!onRemove) return;
    setRemovingId(stewardId);
    try {
      await onRemove(stewardId);
    } finally {
      setRemovingId(null);
    }
  };

  const getScopeLabel = (steward: Steward) => {
    const config = scopeConfig[steward.scope];
    let target = "";
    if (steward.scope === "tag") target = steward.tagName || "";
    else if (steward.scope === "document") target = steward.nodeTitle || steward.nodePattern || "";

    return (
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <config.icon className="h-3 w-3" />
        <span>{config.label}</span>
        {target && <span className="opacity-75">: {target}</span>}
      </div>
    );
  };

  const initial = (s: Steward) => (s.userEmail[0] || "?").toUpperCase();

  if (loading) {
    return (
      <div className={cn("flex items-center justify-center py-4", className)}>
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (stewards.length === 0) {
    return (
      <div className={cn("text-center py-4", className)}>
        <Shield className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground mb-2">No stewards assigned</p>
        {onAddSteward && (
          <Button variant="outline" size="sm" onClick={onAddSteward}>
            <UserPlus className="h-4 w-4 mr-2" />
            Assign Steward
          </Button>
        )}
      </div>
    );
  }

  if (compact) {
    return (
      <div className={cn("flex items-center gap-1", className)}>
        <Shield className="h-4 w-4 text-muted-foreground" />
        <div className="flex -space-x-2">
          {stewards.slice(0, 3).map((steward) => (
            <Avatar key={steward.id} className="h-6 w-6 border-2 border-background">
              <AvatarFallback className="text-[10px]">{initial(steward)}</AvatarFallback>
            </Avatar>
          ))}
        </div>
        {stewards.length > 3 && (
          <span className="text-xs text-muted-foreground">+{stewards.length - 3}</span>
        )}
        {onAddSteward && (
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onAddSteward}>
            <UserPlus className="h-3 w-3" />
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      {stewards.map((steward) => (
        <div
          key={steward.id}
          className="flex items-center gap-3 p-2 rounded-lg border bg-card"
        >
          <Avatar className="h-8 w-8">
            <AvatarFallback>{initial(steward)}</AvatarFallback>
          </Avatar>

          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm truncate">{steward.userEmail}</p>
            {showScope && getScopeLabel(steward)}
            <div className="flex items-center gap-1 mt-1">
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 capitalize">
                {steward.role}
              </Badge>
            </div>
          </div>

          {onRemove && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  disabled={removingId === steward.id}
                >
                  {removingId === steward.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <MoreVertical className="h-4 w-4" />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => handleRemove(steward.id)}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      ))}
      {onAddSteward && (
        <Button variant="outline" className="w-full" onClick={onAddSteward}>
          <UserPlus className="h-4 w-4 mr-2" />
          Add Steward
        </Button>
      )}
    </div>
  );
}
