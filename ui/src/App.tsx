import { useEffect, useRef, useState } from "react";
import { Login } from "./components/Login";
import { Dashboard } from "./components/Dashboard";
import { NestView } from "./components/NestView";
import { DocumentEditor } from "./components/DocumentEditor";
import { AdminLoginModal } from "./components/AdminLoginModal";
import { TeammatesPage } from "./components/TeammatesPage";
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
import { useAuth } from "./auth/AuthContext";

type View =
  | { page: "dashboard" }
  | { page: "nest"; nestId: string; nestName: string }
  | {
      page: "document";
      nestId: string;
      nestName: string;
      nodeId: string | "new";
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

  if (loading || authMode === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Connecting...</div>
      </div>
    );
  }

  if (!authenticated && authMode === "key") {
    return <Login />;
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
                onLogout={logout}
              />
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAdminLogin(true)}
              >
                <Shield className="h-3.5 w-3.5 mr-1" />
                {adminStatus?.claimed ? "Login" : "Claim as Admin"}
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-6xl mx-auto px-4 py-6">
        {view.page === "dashboard" && (
          <Dashboard
            onSelectNest={(id, name) =>
              setView({ page: "nest", nestId: id, nestName: name })
            }
          />
        )}
        {view.page === "nest" && (
          <NestView
            nestId={view.nestId}
            nestName={view.nestName}
            onBack={() => setView({ page: "dashboard" })}
            onOpenDocument={(nodeId) =>
              setView({
                page: "document",
                nestId: view.nestId,
                nestName: view.nestName,
                nodeId,
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
              })
            }
            onSaved={() =>
              setView({
                page: "nest",
                nestId: view.nestId,
                nestName: view.nestName,
              })
            }
            onNavigateDocument={(linkNestId, linkNodeId) =>
              // Cross-nest links don't carry the target nest's name —
              // we keep the current nestName as a best-effort label.
              // The DocumentEditor reloads from the server anyway.
              setView({
                page: "document",
                nestId: linkNestId,
                nestName:
                  linkNestId === view.nestId ? view.nestName : "Document",
                nodeId: linkNodeId,
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
          alreadyClaimed={!!adminStatus?.claimed}
          existingAdmin={adminStatus?.admin?.email || null}
          onClose={() => setShowAdminLogin(false)}
        />
      )}
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
