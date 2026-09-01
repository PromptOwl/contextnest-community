/**
 * ShareNestDialog — surface the nest sharing controls the backend already
 * exposes (see src/nests/sharing-routes.ts):
 *   - PATCH /visibility        → private ↔ public
 *   - GET    /collaborators    → who has access
 *   - POST   /collaborators    → add a person by email at read/write/admin
 *   - PATCH  /collaborators/:id → change their permission
 *   - DELETE /collaborators/:id → revoke access
 *
 * Collaborators are intentionally distinct from stewards: this is plain
 * access sharing (viewer/editor/admin), not the approval-workflow steward
 * role. That's why sharing a private nest no longer requires stewardship.
 *
 * All actions are admin-gated server-side (the /collaborators and
 * /visibility paths require "admin" — see src/app.ts). Non-admins who
 * reach this dialog get a friendly error rather than a silent no-op.
 */
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from "@/components/ui/tabs";
import { Users, AlertCircle } from "lucide-react";
import { CollaboratorManager } from "./CollaboratorManager";
import { NestVisibilityControl } from "./NestVisibilityControl";
import { TeamShareManager } from "./TeamShareManager";
import { useAuth } from "../auth/AuthContext";

interface ShareNestDialogProps {
  nestId: string;
  nestName: string;
  onClose: () => void;
  /** Fired after any change so the parent can refresh its nest/list state. */
  onChanged: () => void;
}

export function ShareNestDialog({
  nestId,
  nestName,
  onClose,
  onChanged,
}: ShareNestDialogProps) {
  const { adminStatus } = useAuth();
  const currentEmail = adminStatus?.me?.email?.toLowerCase() ?? "";
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            Share nest: {nestName}
          </DialogTitle>
          <DialogDescription>
            Sharing applies to the <strong>whole nest</strong> — every
            document in it. To restrict who can touch an individual document,
            assign stewards instead. Sharing grants plain access; it does not
            make anyone a steward.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Visibility — same control the Collaborators tab renders. */}
          <NestVisibilityControl
            nestId={nestId}
            onChanged={onChanged}
            onError={setError}
          />

          {/* People and Teams split into tabs so the dialog stays short no
              matter how many collaborators or teams a nest has. Only the
              active tab's list renders. */}
          <Tabs defaultValue="people">
            <TabsList className="grid grid-cols-2 w-full">
              <TabsTrigger value="people">People</TabsTrigger>
              <TabsTrigger value="teams">Teams</TabsTrigger>
            </TabsList>
            <TabsContent
              value="people"
              className="mt-3 max-h-[52vh] overflow-y-auto pr-1"
            >
              <CollaboratorManager
                nestId={nestId}
                nestName={nestName}
                onChanged={onChanged}
                currentUserEmail={currentEmail}
              />
            </TabsContent>
            <TabsContent
              value="teams"
              className="mt-3 max-h-[52vh] overflow-y-auto pr-1"
            >
              <TeamShareManager nestId={nestId} onChanged={onChanged} />
            </TabsContent>
          </Tabs>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
