import { useCallback, useEffect, useRef, useState } from "react";
import { Login } from "./components/Login";
import { Dashboard } from "./components/Dashboard";
import { NestView } from "./components/NestView";
import { DocumentEditor } from "./components/DocumentEditor";
import { AdminLoginModal } from "./components/AdminLoginModal";
import { TeammatesPage } from "./components/TeammatesPage";
import { LicenseSetupPage } from "./components/LicenseSetupPage";
import { getLicenseStatus, getNest, changePassword, type LicenseStatus } from "./lib/api";
import { QuickOpen } from "./components/QuickOpen";
import hootieIcon from "./assets/hootie.svg";
import { Shield, Info, Users, ChevronDown, LogOut, KeyRound, Eye, EyeOff, Network } from "lucide-react";
import { OntologyGraphView } from "./components/OntologyGraphView";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { useAuth } from "./auth/AuthContext";

/** One ancestor in the wiki-link nav chain. */
export interface BreadcrumbEntry {
  nestId: string;
  nestName: string;
  nodeId: string;
  title: string;
  isOwner: boolean;
  isAnonOwned: boolean;
}

type View =
  | { page: "dashboard" }
  | {
      page: "nest";
      nestId: string;
      nestName: string;
      isOwner: boolean;
      isAnonOwned: boolean;
      /** Seed the nest list's search filter when arriving via a tag
       *  click on a document detail page. */
      initialSearch?: string;
    }
  | {
      page: "document";
      nestId: string;
      nestName: string;
      nodeId: string | "new";
      isOwner: boolean;
      isAnonOwned: boolean;
      /** Pre-fill the title when arriving via a broken-wikilink click.
       *  Only meaningful when nodeId === "new". */
      initialTitle?: string;
      /** Prior wiki-link hops, oldest first. Back pops the last entry. */
      breadcrumb?: BreadcrumbEntry[];
    }
  | { page: "teammates" }
  | {
      page: "ontology-graph";
      nestId: string;
      nestName: string;
      isOwner: boolean;
      isAnonOwned: boolean;
    };

// Runs the ?sso_error toast exactly once per page load (survives React
// StrictMode's dev double-mount). Resets naturally on the next full navigation.
let ssoErrorHandled = false;

export default function App() {
  const {
    authMode,
    logoUrl,
    adminStatus,
    authenticated,
    isAdmin,
    loading,
    error,
    logout,
  } = useAuth();
  const [view, setView] = useState<View>({ page: "dashboard" });
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  // ?nest=<id> deep-link probe; 200 → skip Login, mount NestView.
  const [deepLinkProbe, setDeepLinkProbe] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "ok"; nestId: string; nestName: string }
    | { status: "missing" }
  >(() => {
    if (typeof window === "undefined") return { status: "idle" };
    const params = new URLSearchParams(window.location.search);
    const nestId = params.get("nest");
    return nestId ? { status: "loading" } : { status: "idle" };
  });
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(
    null,
  );
  const [licenseLoading, setLicenseLoading] = useState(true);
  // Logout flow: confirm dialog → call logout() → sonner success toast.
  // The Toaster portal lives at the root of the tree (rendered below)
  // so the toast survives the view swap that logout triggers (Login
  // screen mounts when authenticated flips false in key mode).
  const [logoutConfirm, setLogoutConfirm] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  // Cmd/Ctrl+K quick-open — active anywhere inside a nest context.
  const [showQuickOpen, setShowQuickOpen] = useState(false);

  const requestLogout = useCallback(() => setLogoutConfirm(true), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowQuickOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const confirmLogout = useCallback(async () => {
    setLogoutPending(true);
    try {
      await logout();
      setLogoutConfirm(false);
      toast.success("Logged out successfully");
    } finally {
      setLogoutPending(false);
    }
  }, [logout]);

  const refreshLicense = useCallback(async () => {
    try {
      const status = await getLicenseStatus();
      setLicenseStatus(status);
    } catch {
      // Endpoint unreachable — fall through to normal app; the rest of the
      // UI will surface a connection error on its own fetches.
      setLicenseStatus(null);
    } finally {
      setLicenseLoading(false);
    }
  }, []);

  // Probe GET /nests/:id once on mount. URL left intact so refresh re-probes.
  useEffect(() => {
    if (deepLinkProbe.status !== "loading") return;
    const params = new URLSearchParams(window.location.search);
    const nestId = params.get("nest");
    if (!nestId) {
      setDeepLinkProbe({ status: "missing" });
      return;
    }
    (async () => {
      try {
        const { nest } = await getNest(nestId);
        setDeepLinkProbe({
          status: "ok",
          nestId: nest.id,
          nestName: nest.name,
        });
        // ?doc=<nodeId> → open that document directly (the doc view's own
        // load surfaces a not-found error if the id is stale).
        const docId = params.get("doc");
        if (docId && docId !== "new") {
          setView({
            page: "document",
            nestId: nest.id,
            nestName: nest.name,
            nodeId: docId,
            isOwner: false,
            isAnonOwned: false,
          });
          return;
        }
        setView({
          page: "nest",
          nestId: nest.id,
          nestName: nest.name,
          isOwner: false,
          isAnonOwned: false,
        });
      } catch {
        setDeepLinkProbe({ status: "missing" });
      }
    })();
  }, [deepLinkProbe.status]);

  // Keep the URL in sync with the current view so documents (and nests) are
  // shareable — paste the address bar and the recipient lands on the same doc.
  // The probe above consumes ?nest / ?doc on load, so we must NOT rewrite the
  // URL while it's still "loading", or we'd clobber the params before it reads
  // them. ?doc is omitted for unsaved ("new") documents.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (deepLinkProbe.status === "loading") return;
    const params = new URLSearchParams(window.location.search);
    if (view.page === "document") {
      params.set("nest", view.nestId);
      if (view.nodeId && view.nodeId !== "new") params.set("doc", view.nodeId);
      else params.delete("doc");
    } else if (view.page === "nest") {
      params.set("nest", view.nestId);
      params.delete("doc");
    } else {
      params.delete("nest");
      params.delete("doc");
    }
    const qs = params.toString();
    const next =
      window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
    const current =
      window.location.pathname + window.location.search + window.location.hash;
    if (next !== current) {
      window.history.replaceState({}, "", next);
    }
  }, [view, deepLinkProbe.status]);

  // One-click PromptOwl SSO (GET /auth/sso) bounces back to "/?sso_error=<code>"
  // when a ticket can't be redeemed (bad/expired/replayed ticket, wrong
  // audience, rate limit, sign-in gate) or when this community doesn't support
  // SSO at all (no shared secret on a self-hosted deploy → "not_supported").
  // Surface a human-readable toast and strip the param so a refresh doesn't
  // re-fire it.
  //
  // The module-level guard + deferred toast handle React StrictMode's dev
  // double-mount: the effect fires twice, and a toast queued synchronously in
  // the first pass is dropped when sonner's <Toaster> remounts. The guard runs
  // the body exactly once per page load (each SSO redirect is a full
  // navigation, so it resets), and the setTimeout lets the toast land after the
  // mount churn settles so it actually renders.
  useEffect(() => {
    if (typeof window === "undefined" || ssoErrorHandled) return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("sso_error");
    if (!code) return;
    ssoErrorHandled = true;

    params.delete("sso_error");
    const qs = params.toString();
    window.history.replaceState(
      {},
      "",
      window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
    );

    const messages: Record<string, string> = {
      not_supported: "One-click sign-in isn't available on this community.",
      missing_ticket: "The sign-in link was incomplete. Try again from PromptOwl.",
      invalid_ticket: "The sign-in link is invalid or has expired. Try again from PromptOwl.",
      bad_audience: "This sign-in link was issued for a different community.",
      ticket_used: "This sign-in link was already used. Start again from PromptOwl.",
      rate_limited: "Too many sign-in attempts. Wait a moment and try again.",
      sign_in_restricted: "Sign-in is restricted on this community. Contact an admin.",
      service_error: "Something went wrong signing you in. Please try again.",
    };
    const msg = messages[code] ?? "Sign-in failed. Try again from PromptOwl.";
    setTimeout(() => toast.error(msg), 0);
  }, []);

  useEffect(() => {
    refreshLicense();
    // Server-side watcher revokes sessions within seconds of a
    // deactivation, so the next API call this tab makes returns 401
    // and `auth:unauthorized` is the real-time signal that bounces us
    // to the setup screen. The 15-minute interval is a safety net for
    // idle tabs that aren't issuing any other requests.
    const interval = setInterval(refreshLicense, 15 * 60 * 1000);
    const onUnauth = () => {
      refreshLicense();
    };
    window.addEventListener("auth:unauthorized", onUnauth);
    return () => {
      clearInterval(interval);
      window.removeEventListener("auth:unauthorized", onUnauth);
    };
  }, [refreshLicense]);

  // Reset view on user-switch (logout/login). Skip initial null→email
  // (just auth resolving — would clobber deep-link view).
  const currentUserEmail = adminStatus?.me?.email ?? null;
  const prevUserEmailRef = useRef<string | null>(currentUserEmail);
  useEffect(() => {
    if (prevUserEmailRef.current === currentUserEmail) return;
    const wasLoggedIn = prevUserEmailRef.current !== null;
    prevUserEmailRef.current = currentUserEmail;
    if (wasLoggedIn) {
      setView({ page: "dashboard" });
    }
  }, [currentUserEmail]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-lg font-medium text-destructive">{error}</p>
          <p className="text-sm text-muted-foreground mt-1">
            Check that the community server is running.
          </p>
        </div>
      </div>
    );
  }

  if (
    loading ||
    authMode === null ||
    licenseLoading ||
    deepLinkProbe.status === "loading"
  ) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Connecting...</div>
      </div>
    );
  }

  // Setup gate: no valid license = force operator through install
  // before anything else loads.
  if (licenseStatus && !licenseStatus.valid) {
    return <LicenseSetupPage onActivated={refreshLicense} />;
  }

  // Logout chrome (confirm dialog + success toast) lives at the top of
  // the render tree so it survives the unmount/remount that happens when
  // logout flips `authenticated` and the app swaps to <Login />.
  const logoutChrome = (
    <>
      <Dialog
        open={logoutConfirm}
        onOpenChange={(open) => {
          if (!open && !logoutPending) setLogoutConfirm(false);
        }}
      >
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <LogOut className="h-4 w-4 text-muted-foreground" />
              Log out?
            </DialogTitle>
            <DialogDescription>
              You'll be signed out of this browser. Any unsaved edits in
              other tabs may be lost — save your work first.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setLogoutConfirm(false)}
              disabled={logoutPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmLogout}
              disabled={logoutPending}
            >
              {logoutPending ? "Logging out..." : "Log out"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ChangePasswordDialog
        open={showChangePassword}
        onClose={() => setShowChangePassword(false)}
      />

      {showQuickOpen &&
        (view.page === "nest" || view.page === "document") && (
          <QuickOpen
            nestId={view.nestId}
            onClose={() => setShowQuickOpen(false)}
            onSelect={(nodeId) => {
              setShowQuickOpen(false);
              setView({
                page: "document",
                nestId: view.nestId,
                nestName: view.nestName,
                nodeId,
                isOwner: view.isOwner,
                isAnonOwned: view.isAnonOwned,
              });
            }}
          />
        )}
    </>
  );

  // Unauth + key mode → Login, unless deep-link probe resolved a public nest.
  if (!authenticated && authMode === "key" && deepLinkProbe.status !== "ok") {
    return (
      <>
        <Login />
        {logoutChrome}
      </>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <button
            onClick={() => setView({ page: "dashboard" })}
            className="flex items-center gap-2 hover:opacity-80"
          >
            <img
              src={logoUrl ?? hootieIcon}
              alt="ContextNest"
              className="h-7 w-7 object-contain"
            />
            <span className="font-semibold">ContextNest</span>
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              Community
            </Badge>
          </button>

          <div className="flex items-center gap-2">
            {/* Mode indicator — only when not logged-in (logged-in
                users see open-mode context inside the dropdown) */}
            {authMode === "open" && !adminStatus?.me && (
              <span className="hidden md:inline-flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded">
                <Info className="h-3 w-3" />
                Open mode
              </span>
            )}
            {/* Unauth deep-link visitor badge. */}
            {authMode === "key" && !authenticated && (
              <span className="hidden md:inline-flex items-center gap-1.5 text-xs text-blue-700 bg-blue-50 border border-blue-200 px-2 py-1 rounded">
                <Info className="h-3 w-3" />
                Public read-only
              </span>
            )}

            {view.page === "nest" && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setView({
                    page: "ontology-graph",
                    nestId: view.nestId,
                    nestName: view.nestName,
                    isOwner: view.isOwner,
                    isAnonOwned: view.isAnonOwned,
                  })
                }
              >
                <Network className="h-3.5 w-3.5 mr-1" />
                Graph
              </Button>
            )}

            {adminStatus?.me ? (
              <UserMenu
                me={adminStatus.me}
                isAdmin={isAdmin}
                onTeammates={() => setView({ page: "teammates" })}
                onChangePassword={() => setShowChangePassword(true)}
                onLogout={requestLogout}
              />
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAdminLogin(true)}
              >
                <Shield className="h-3.5 w-3.5 mr-1" />
                Login
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-6xl mx-auto px-4 py-6">
        {view.page === "dashboard" && (
          <Dashboard
            onSelectNest={(id, name, isOwner, isAnonOwned) =>
              setView({
                page: "nest",
                nestId: id,
                nestName: name,
                isOwner,
                isAnonOwned,
              })
            }
          />
        )}
        {view.page === "nest" && (
          <NestView
            nestId={view.nestId}
            nestName={view.nestName}
            isOwner={view.isOwner}
            isAnonOwned={view.isAnonOwned}
            initialSearch={view.initialSearch}
            onBack={() => {
              // Drop ?nest from URL so refresh doesn't re-enter the nest.
              if (typeof window !== "undefined") {
                const params = new URLSearchParams(window.location.search);
                if (params.has("nest")) {
                  params.delete("nest");
                  const qs = params.toString();
                  window.history.replaceState(
                    {},
                    "",
                    window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
                  );
                }
              }
              // Unauth → bounce to Login (Dashboard would 401).
              if (!authenticated && authMode === "key") {
                setDeepLinkProbe({ status: "missing" });
              }
              setView({ page: "dashboard" });
            }}
            onOpenDocument={(nodeId) =>
              setView({
                page: "document",
                nestId: view.nestId,
                nestName: view.nestName,
                nodeId,
                isOwner: view.isOwner,
                isAnonOwned: view.isAnonOwned,
              })
            }
          />
        )}
        {view.page === "document" && (() => {
          // Shared nav helpers to avoid setView shape duplication.
          const doc = view;
          const openDocument = (target: {
            nestId: string;
            nestName: string;
            nodeId: string | "new";
            isOwner: boolean;
            isAnonOwned: boolean;
            initialTitle?: string;
            breadcrumb?: BreadcrumbEntry[];
          }) => setView({ page: "document", ...target });
          const openNest = (initialSearch?: string) =>
            setView({
              page: "nest",
              nestId: doc.nestId,
              nestName: doc.nestName,
              isOwner: doc.isOwner,
              isAnonOwned: doc.isAnonOwned,
              initialSearch,
            });
          return (
            <DocumentEditor
              // Key by nest + node so React unmounts the editor when the
              // user hops to a different doc (wiki-link nav) or pivots
              // from an existing doc into a fresh "new" page via a
              // broken-link click. Without this, useState values (title,
              // content, status) survive the prop change and the old
              // doc's body renders under the new doc's chrome — and
              // isNew flips true with stale state, hiding the status
              // badge + Submit-for-review button on the original doc.
              key={`${doc.nestId}/${doc.nodeId}`}
              nestId={doc.nestId}
              nestName={doc.nestName}
              nodeId={doc.nodeId}
              isOwner={doc.isOwner}
              breadcrumb={doc.breadcrumb}
              onBack={() => {
                // Pop last ancestor when chain non-empty; else nest list.
                const stack = doc.breadcrumb ?? [];
                if (stack.length > 0) {
                  const prev = stack[stack.length - 1];
                  openDocument({ ...prev, breadcrumb: stack.slice(0, -1) });
                  return;
                }
                openNest();
              }}
              onJumpBreadcrumb={(index) => {
                // Jump to ancestor at index; drop entries after.
                const stack = doc.breadcrumb ?? [];
                const entry = stack[index];
                if (!entry) return;
                openDocument({ ...entry, breadcrumb: stack.slice(0, index) });
              }}
              onSaved={() => openNest()}
              onNavigateDocument={(linkNestId, linkNodeId, currentTitle) => {
                // Cycle handling: never duplicate target in chain.
                //  - target == current doc → no-op (self-link).
                //  - target already in stack → truncate to that occurrence (jump-back).
                //  - else → push current onto stack.
                const stack = doc.breadcrumb ?? [];
                const sameNest = linkNestId === doc.nestId;
                if (linkNestId === doc.nestId && linkNodeId === doc.nodeId) {
                  return;
                }
                const existingIdx = stack.findIndex(
                  (e) => e.nestId === linkNestId && e.nodeId === linkNodeId,
                );
                if (existingIdx !== -1) {
                  openDocument({
                    nestId: linkNestId,
                    nestName: sameNest ? doc.nestName : "Document",
                    nodeId: linkNodeId,
                    isOwner: sameNest ? doc.isOwner : false,
                    isAnonOwned: sameNest ? doc.isAnonOwned : false,
                    breadcrumb: stack.slice(0, existingIdx),
                  });
                  return;
                }
                const nextStack =
                  doc.nodeId !== "new"
                    ? [
                        ...stack,
                        {
                          nestId: doc.nestId,
                          nestName: doc.nestName,
                          nodeId: doc.nodeId,
                          title: currentTitle?.trim() || "Untitled",
                          isOwner: doc.isOwner,
                          isAnonOwned: doc.isAnonOwned,
                        },
                      ]
                    : stack;
                openDocument({
                  nestId: linkNestId,
                  nestName: sameNest ? doc.nestName : "Document",
                  nodeId: linkNodeId,
                  isOwner: sameNest ? doc.isOwner : false,
                  isAnonOwned: sameNest ? doc.isAnonOwned : false,
                  breadcrumb: nextStack,
                });
              }}
              onTagClick={(tag) =>
                // Tag chip → nest list filtered by tag.
                openNest(tag)
              }
              onCreateDocument={(linkNestId, initialTitle) =>
                // Broken `[[Title]]` → new-doc page with title pre-filled.
                openDocument({
                  nestId: linkNestId,
                  nestName: doc.nestName,
                  nodeId: "new",
                  isOwner: doc.isOwner,
                  isAnonOwned: doc.isAnonOwned,
                  initialTitle,
                })
              }
              initialTitle={doc.initialTitle}
            />
          );
        })()}
        {view.page === "teammates" && (
          <TeammatesPage onBack={() => setView({ page: "dashboard" })} />
        )}
        {view.page === "ontology-graph" && (
          <OntologyGraphView
            nestId={view.nestId}
            nestName={view.nestName}
            onBack={() =>
              setView({
                page: "nest",
                nestId: view.nestId,
                nestName: view.nestName,
                isOwner: view.isOwner,
                isAnonOwned: view.isAnonOwned,
              })
            }
          />
        )}
      </main>

      {showAdminLogin && (
        <AdminLoginModal
          existingAdmin={adminStatus?.admin?.email || null}
          onClose={() => setShowAdminLogin(false)}
        />
      )}
      {logoutChrome}
    </div>
  );
}

interface UserMenuProps {
  me: { email: string; name: string | null; is_admin: boolean };
  isAdmin: boolean;
  onTeammates: () => void;
  onChangePassword: () => void;
  onLogout: () => void;
}

function UserMenu({
  me,
  isAdmin,
  onTeammates,
  onChangePassword,
  onLogout,
}: UserMenuProps) {
  const displayName = me.name?.trim() || me.email;
  const initial = displayName.charAt(0);

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="group h-9 gap-2 px-2"
          data-testid="user-menu-trigger"
        >
          <Avatar className="h-[1.8rem] w-[1.8rem] rounded-sm shrink-0">
            <AvatarFallback className="rounded-sm">{initial}</AvatarFallback>
          </Avatar>
          <span className="hidden sm:inline max-w-[140px] truncate text-sm font-medium">
            {displayName}
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <div className="flex items-center gap-2 p-2">
          <Avatar className="h-8 w-8 rounded-sm shrink-0">
            <AvatarFallback className="rounded-sm">{initial}</AvatarFallback>
          </Avatar>
          <div className="grid gap-0.5 leading-none min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold truncate">{displayName}</span>
              {isAdmin && (
                <Badge
                  variant="outline"
                  className="gap-1 border-blue-200 bg-blue-50 text-blue-700 text-[10px] px-1.5 py-0"
                >
                  <Shield className="h-2.5 w-2.5" />
                  Admin
                </Badge>
              )}
            </div>
            <div className="text-sm text-muted-foreground truncate">
              {me.email}
            </div>
          </div>
        </div>
        {isAdmin && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onTeammates} className="cursor-pointer">
              <Users className="h-3.5 w-3.5 mr-2" />
              Teammates
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onChangePassword}
          className="cursor-pointer"
          data-testid="user-menu-change-password"
        >
          <KeyRound className="h-3.5 w-3.5 mr-2" />
          Change password
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onLogout}
          className="cursor-pointer text-red-600 focus:text-red-700"
          data-testid="user-menu-logout"
        >
          <LogOut className="h-3.5 w-3.5 mr-2" />
          Logout
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Self-service password change — usable by anyone signed in, including a user
// who logged in with an admin-issued temporary password. Calls /auth/password,
// which verifies the current password and invalidates other sessions.
// Eye toggle pinned inside a password field to reveal/hide the value.
function PasswordToggle({
  shown,
  onToggle,
}: {
  shown: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      tabIndex={-1}
      aria-label={shown ? "Hide password" : "Show password"}
      title={shown ? "Hide password" : "Show password"}
      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
    >
      {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </button>
  );
}

function ChangePasswordDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Reveal toggles per field so a user can verify what they typed.
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const reset = () => {
    setCurrent("");
    setNext("");
    setConfirm("");
    setError(null);
    setShowCurrent(false);
    setShowNext(false);
    setShowConfirm(false);
  };

  const submit = async () => {
    setError(null);
    if (next.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (next !== confirm) {
      setError("New passwords don't match.");
      return;
    }
    if (next === current) {
      setError("New password must be different from the current password.");
      return;
    }
    setSaving(true);
    try {
      await changePassword(current, next);
      toast.success("Password changed. Your other sessions were signed out.");
      reset();
      onClose();
    } catch (e: any) {
      setError(e?.message || "Could not change password.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !saving) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            Change password
          </DialogTitle>
          <DialogDescription>
            If an admin gave you a temporary password, set your own here. This
            signs out your other sessions.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="space-y-1">
            <label
              htmlFor="cp-current"
              className="block text-sm font-medium"
            >
              Current password
            </label>
            <div className="relative">
              <Input
                id="cp-current"
                type={showCurrent ? "text" : "password"}
                placeholder="Enter your current password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
                className="pr-10"
              />
              <PasswordToggle
                shown={showCurrent}
                onToggle={() => setShowCurrent((s) => !s)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <label htmlFor="cp-next" className="block text-sm font-medium">
              New password
            </label>
            <div className="relative">
              <Input
                id="cp-next"
                type={showNext ? "text" : "password"}
                placeholder="At least 8 characters"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
                className="pr-10"
              />
              <PasswordToggle
                shown={showNext}
                onToggle={() => setShowNext((s) => !s)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <label
              htmlFor="cp-confirm"
              className="block text-sm font-medium"
            >
              Confirm new password
            </label>
            <div className="relative">
              <Input
                id="cp-confirm"
                type={showConfirm ? "text" : "password"}
                placeholder="Re-enter your new password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                aria-invalid={confirm.length > 0 && confirm !== next}
                className="pr-10"
              />
              <PasswordToggle
                shown={showConfirm}
                onToggle={() => setShowConfirm((s) => !s)}
              />
            </div>
            {confirm.length > 0 && confirm !== next && (
              <p className="text-sm text-destructive">
                Passwords don't match.
              </p>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onClose();
            }}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={saving || !current || !next || !confirm || next !== confirm}
          >
            {saving ? "Saving..." : "Change password"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
