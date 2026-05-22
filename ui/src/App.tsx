import { useCallback, useEffect, useRef, useState } from "react";
import { Login } from "./components/Login";
import { Dashboard } from "./components/Dashboard";
import { NestView } from "./components/NestView";
import { DocumentEditor } from "./components/DocumentEditor";
import { AdminLoginModal } from "./components/AdminLoginModal";
import { TeammatesPage } from "./components/TeammatesPage";
import { LicenseSetupPage } from "./components/LicenseSetupPage";
import { getLicenseStatus, type LicenseStatus } from "./lib/api";
import hootieIcon from "./assets/hootie.svg";
import { Shield, Info, Users, ChevronDown, LogOut } from "lucide-react";
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

type View =
  | { page: "dashboard" }
  | {
      page: "nest";
      nestId: string;
      nestName: string;
      isOwner: boolean;
      isAnonOwned: boolean;
    }
  | {
      page: "document";
      nestId: string;
      nestName: string;
      nodeId: string | "new";
      isOwner: boolean;
      isAnonOwned: boolean;
    }
  | { page: "teammates" };

export default function App() {
  const {
    authMode,
    adminStatus,
    authenticated,
    isAdmin,
    loading,
    error,
    logout,
  } = useAuth();
  const [view, setView] = useState<View>({ page: "dashboard" });
  const [showAdminLogin, setShowAdminLogin] = useState(false);
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

  const requestLogout = useCallback(() => setLogoutConfirm(true), []);

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

  // Reset to the dashboard whenever the signed-in user changes. App
  // doesn't unmount across logout/login so `view` would otherwise
  // carry the prior session's selected nest into the next user's
  // session — that lets user B land directly inside user A's nest
  // even when they lack access (server still 403s, but UX is wrong).
  // Tracking the previous email (incl. logged-out → null) catches
  // logout, login, and user-switch in one effect.
  const currentUserEmail = adminStatus?.me?.email ?? null;
  const prevUserEmailRef = useRef<string | null>(currentUserEmail);
  useEffect(() => {
    if (prevUserEmailRef.current !== currentUserEmail) {
      prevUserEmailRef.current = currentUserEmail;
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

  if (loading || authMode === null || licenseLoading) {
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

    </>
  );

  if (!authenticated && authMode === "key") {
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
            <img src={hootieIcon} alt="ContextNest" className="h-7 w-7" />
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

            {adminStatus?.me ? (
              <UserMenu
                me={adminStatus.me}
                isAdmin={isAdmin}
                onTeammates={() => setView({ page: "teammates" })}
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
            onBack={() => setView({ page: "dashboard" })}
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
        {view.page === "document" && (
          <DocumentEditor
            nestId={view.nestId}
            nestName={view.nestName}
            nodeId={view.nodeId}
            onBack={() =>
              setView({
                page: "nest",
                nestId: view.nestId,
                nestName: view.nestName,
                isOwner: view.isOwner,
                isAnonOwned: view.isAnonOwned,
              })
            }
            onSaved={() =>
              setView({
                page: "nest",
                nestId: view.nestId,
                nestName: view.nestName,
                isOwner: view.isOwner,
                isAnonOwned: view.isAnonOwned,
              })
            }
            onNavigateDocument={(linkNestId, linkNodeId) =>
              // Cross-nest links don't carry the target nest's name or
              // ownership — keep current values as a best-effort and let
              // DocumentEditor reload. Delete affordance in NestView
              // will be hidden for cross-nest hops it can't verify.
              setView({
                page: "document",
                nestId: linkNestId,
                nestName:
                  linkNestId === view.nestId ? view.nestName : "Document",
                nodeId: linkNodeId,
                isOwner: linkNestId === view.nestId ? view.isOwner : false,
                isAnonOwned:
                  linkNestId === view.nestId ? view.isAnonOwned : false,
              })
            }
          />
        )}
        {view.page === "teammates" && (
          <TeammatesPage onBack={() => setView({ page: "dashboard" })} />
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
  onLogout: () => void;
}

function UserMenu({ me, isAdmin, onTeammates, onLogout }: UserMenuProps) {
  const displayName = me.name?.trim() || me.email;
  const initial = displayName.charAt(0);

  return (
    <DropdownMenu>
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
