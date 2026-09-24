/**
 * Copy for the "remove collaborator" confirmation dialog. Pulled out to its
 * own pure function so it stays unit-testable without a render harness (this
 * repo's vitest config runs with environment: "node", no jsdom/RTL — see
 * CollaboratorManager's use of AlertDialog, which replaced a native
 * window.confirm() that also leaked the deployment's Cloud Run URL in the
 * browser's popup chrome).
 */
export interface RemoveCollaboratorConfirmCopy {
  title: string;
  body: string;
  confirm: string;
}

export function removeCollaboratorConfirmCopy(
  collaboratorEmail: string | undefined,
  nestName: string,
): RemoveCollaboratorConfirmCopy {
  const who = collaboratorEmail || "this collaborator";
  return {
    title: "Remove access?",
    body: `Remove ${who}'s access to "${nestName}"? They keep their account; only their access to this nest is revoked.`,
    confirm: "Remove access",
  };
}
