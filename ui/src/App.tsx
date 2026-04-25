import React, { useState, useEffect, useCallback } from "react";
import * as api from "./lib/api";
import { Login } from "./components/Login";
import { Dashboard } from "./components/Dashboard";
import { NestView } from "./components/NestView";
import { AdminLoginModal } from "./components/AdminLoginModal";
import { TeammatesPage } from "./components/TeammatesPage";
import hootieIcon from "./assets/hootie.svg";
import { Shield, Info, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type View =
  | { page: "dashboard" }
  | { page: "nest"; nestId: string; nestName: string }
  | { page: "teammates" };

interface AdminStatus {
  claimed: boolean;
  admin: { email: string; name: string | null } | null;
  me: { email: string; is_admin: boolean } | null;
}

export default function App() {
  const [authMode, setAuthMode] = useState<"open" | "key" | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [view, setView] = useState<View>({ page: "dashboard" });
  const [error, setError] = useState<string | null>(null);
  const [adminStatus, setAdminStatus] = useState<AdminStatus | null>(null);
  const [showAdminLogin, setShowAdminLogin] = useState(false);

  const refreshAdminStatus = useCallback(async () => {
    try {
      const s = await api.getAdminStatus();
      setAdminStatus(s);
    } catch {}
  }, []);

  useEffect(() => {
    api
      .getHealth()
      .then((h) => {
        setAuthMode(h.auth_mode as any);
        if (h.auth_mode === "open" || api.hasToken()) {
          setAuthenticated(true);
        }
      })
      .catch(() => setError("Cannot connect to server"));
    refreshAdminStatus();
  }, [refreshAdminStatus]);

  const handleLogout = () => {
    api.clearToken();
    setAuthenticated(authMode === "open");
    refreshAdminStatus();
  };

  const handleAdminLogin = () => {
    setShowAdminLogin(false);
    refreshAdminStatus();
    if (authMode === "key") setAuthenticated(true);
  };

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

  if (authMode === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Connecting...</div>
      </div>
    );
  }

  if (!authenticated && authMode === "key") {
    return <Login onLogin={() => setAuthenticated(true)} />;
  }

  const isAdmin = !!adminStatus?.me?.is_admin;

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
            {/* Mode indicator */}
            {authMode === "open" && !isAdmin && (
              <span className="hidden md:inline-flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded">
                <Info className="h-3 w-3" />
                Open mode
              </span>
            )}

            {/* Admin badge + teammates button */}
            {isAdmin && (
              <>
                <Badge
                  variant="outline"
                  className="gap-1 border-blue-200 bg-blue-50 text-blue-700"
                >
                  <Shield className="h-3 w-3" />
                  Admin: {adminStatus?.me?.email}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setView({ page: "teammates" })}
                >
                  <Users className="h-3.5 w-3.5 mr-1" />
                  Teammates
                </Button>
              </>
            )}

            {/* Login / Logout */}
            {adminStatus?.me ? (
              <Button variant="ghost" size="sm" onClick={handleLogout}>
                Logout
              </Button>
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
            isAdmin={isAdmin}
            onBack={() => setView({ page: "dashboard" })}
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
          onLoggedIn={handleAdminLogin}
        />
      )}
    </div>
  );
}
