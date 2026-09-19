/**
 * Stewards tab — who governs what. Owns its read (reads.stewards) and its
 * loader; every /stewards write already drops that key (queries.ts), so the
 * roster refreshes itself after the assign / edit / remove dialogs NestView
 * still hosts (assign is also reachable from the nest's overflow menu).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Shield } from "lucide-react";
import { reads } from "../../lib/queries";
import { StewardList, type Steward, type StewardRole } from "../governance";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Props {
  nestId: string;
  /** Owner / nest admin — may assign, edit and remove. */
  canManage: boolean;
  currentUserEmail?: string;
  onAssign: () => void;
  onRemove: (stewardId: string) => void;
  onEditRole: (steward: Steward) => void;
}

export function StewardsTab({ nestId, canManage, currentUserEmail, onAssign, onRemove, onEditRole }: Props) {
  const roster = useQuery(reads.stewards(nestId));
  const stewards = roster.data?.stewards ?? [];
  const [scope, setScope] = useState<"all" | "document" | "tag" | "nest">("all");
  const [role, setRole] = useState<"all" | StewardRole>("all");

  return (
    <>
      <Card className="border-blue-200 bg-blue-50/40">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Shield className="h-4 w-4 text-blue-700" />
            How stewardship works
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground space-y-2 leading-relaxed">
          <p>
            <strong className="text-foreground">New documents start as drafts.</strong>{" "}
            They're not available to AI queries until a steward approves them.
          </p>
          <p>
            <strong className="text-foreground">Stewards</strong> are people you name to
            govern content by scope. Resolution priority (first match wins):
          </p>
          <ol className="list-decimal list-inside ml-2 space-y-0.5">
            <li><strong>Document</strong> — this exact doc</li>
            <li><strong>Tag</strong> — everything with #tag</li>
            <li><strong>Nest</strong> — anything not matched above</li>
          </ol>
          <p>
            <strong className="text-foreground">Reviewers</strong> can approve/reject;{" "}
            <strong className="text-foreground">editors</strong> can edit;{" "}
            <strong className="text-foreground">viewers</strong> have read access. Authors
            can't approve their own work.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-lg">Stewards</CardTitle>
              <CardDescription>
                {roster.isLoading
                  ? "Loading…"
                  : stewards.length === 0
                    ? "Nobody's governing content yet"
                    : "Who governs what"}
              </CardDescription>
            </div>
            {stewards.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                {(["all", "document", "tag", "nest"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setScope(s)}
                    className={`text-xs px-2 py-1 rounded border ${
                      scope === s
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground border-border hover:bg-secondary"
                    }`}
                  >
                    {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
                  </button>
                ))}
                <span className="w-px h-4 bg-border" />
                <Select value={role} onValueChange={(v) => setRole(v as "all" | StewardRole)}>
                  <SelectTrigger className="w-[120px] h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="editor">Editor</SelectItem>
                    <SelectItem value="reviewer">Reviewer</SelectItem>
                    <SelectItem value="viewer">Viewer</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {roster.isLoading ? (
            <StewardList stewards={[]} loading showScope />
          ) : stewards.length === 0 ? (
            <div className="text-sm space-y-3 py-2">
              <p className="text-muted-foreground leading-relaxed">
                Without stewards, every draft needs the nest owner to approve. Add an
                editor/reviewer to delegate approvals for a tag or specific doc.
              </p>
              {canManage && (
                <Button variant="outline" size="sm" className="w-full" onClick={onAssign}>
                  <Shield className="h-3.5 w-3.5 mr-2" />
                  Assign your first steward
                </Button>
              )}
            </div>
          ) : (
            <StewardList
              stewards={stewards.filter(
                (s) =>
                  (scope === "all" || s.scope === scope) && (role === "all" || s.role === role),
              )}
              showScope
              onAddSteward={canManage ? onAssign : undefined}
              onRemove={canManage ? async (id: string) => onRemove(id) : undefined}
              onEditRole={canManage ? onEditRole : undefined}
              currentUserEmail={currentUserEmail}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}
