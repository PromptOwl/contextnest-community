/**
 * Collaborators tab — who can access the nest. The roster and the
 * visibility control fetch for themselves (CollaboratorManager,
 * NestVisibilityControl); this is the tab's chrome around them.
 */
import { toast } from "sonner";
import { CollaboratorManager } from "../CollaboratorManager";
import { NestVisibilityControl } from "../NestVisibilityControl";
import { HeadlessAccessPanel } from "../HeadlessAccessPanel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  nestId: string;
  nestName: string;
  /** Owner / admin — may change visibility. */
  canManage: boolean;
  canManageGovernance: boolean;
  stewardshipEnabled: boolean;
  currentUserEmail: string;
  callerPermission?: string;
  onOpenSettings: () => void;
  /** Access changed — the nest page re-reads its caps. */
  onChanged: () => void;
}

export function CollaboratorsTab({
  nestId,
  nestName,
  canManage,
  canManageGovernance,
  stewardshipEnabled,
  currentUserEmail,
  callerPermission,
  onOpenSettings,
  onChanged,
}: Props) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">Collaborators</CardTitle>
        {/* Two lines, not one paragraph — the stewardship caveat read as an
            aside and was missed (CU-wdqcq018qu). */}
        <CardDescription className="space-y-1">
          <span className="block">
            <strong className="font-medium text-foreground">Who can access this nest</strong>{" "}
            — visibility and access for people and teams. Sharing grants viewer, editor or
            admin access.
          </span>
          <span className="block">
            <strong className="font-medium text-foreground">Stewardship</strong> — sharing
            does not make anyone a steward.
            {stewardshipEnabled ? (
              canManageGovernance
                ? " Use the Reviewer switch to let someone approve documents across the nest; narrower stewards (a tag or one document) are on the Stewards tab."
                : " Stewards are assigned on the Stewards tab."
            ) : canManageGovernance ? (
              // Naming the setting without a way to reach it left the reader
              // hunting through a menu (CU-wdqcq01e75). Only owner/admin can
              // open it, so only they get the link.
              <>
                {" "}
                Turn on Stewardship &amp; Approval Workflow in{" "}
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
                >
                  Nest settings
                </button>{" "}
                to use stewards.
              </>
            ) : (
              " Stewardship & Approval Workflow is off for this nest — an owner or admin can turn it on in Nest settings."
            )}
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Visibility lives here rather than only in the Share dialog, so
            access management is one surface (CU-wdqcpzzzy6). */}
        {canManage && (
          <NestVisibilityControl
            nestId={nestId}
            onChanged={onChanged}
            onError={(msg) => msg && toast.error(msg)}
          />
        )}
        {/* API-only access keys (CU-wdqcq0314u) — another answer to "who can
            read this nest", so it sits with visibility. */}
        {canManage && (
          <HeadlessAccessPanel nestId={nestId} onError={(msg) => msg && toast.error(msg)} />
        )}
        <CollaboratorManager
          nestId={nestId}
          nestName={nestName}
          onChanged={onChanged}
          currentUserEmail={currentUserEmail}
          callerPermission={callerPermission}
          showTeams
          reviewers={stewardshipEnabled && canManageGovernance}
        />
      </CardContent>
    </Card>
  );
}
