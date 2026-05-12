/**
 * AuthContext — single source of truth for auth state.
 *
 * Holds authMode (from /health), adminStatus (from /auth/admin-status),
 * authenticated flag, and exposes loginSuccess / logout / refresh actions.
 *
 * Stale-fetch protection: every refresh bumps a sequence number. Only the
 * latest fetch may write state. Prevents an older in-flight /admin-status
 * from clobbering a newer optimistic update on login.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import * as api from "../lib/api";

type AuthMode = "open" | "key" | null;
type Me = { email: string; is_admin: boolean } | null;

export interface AdminStatus {
  claimed: boolean;
  admin: { email: string; name: string | null } | null;
  me: Me;
}

export interface AuthContextValue {
  authMode: AuthMode;
  adminStatus: AdminStatus | null;
  authenticated: boolean;
  isAdmin: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  loginSuccess: (user?: { email: string; is_admin: boolean }) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [authMode, setAuthMode] = useState<AuthMode>(null);
  const [adminStatus, setAdminStatus] = useState<AdminStatus | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const seqRef = useRef(0);

  const refresh = useCallback(async () => {
    const mySeq = ++seqRef.current;
    try {
      const s = await api.getAdminStatus();
      if (seqRef.current === mySeq) setAdminStatus(s);
    } catch {}
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const h = await api.getHealth();
        if (cancelled) return;
        const mode = h.auth_mode as AuthMode;
        setAuthMode(mode);
        setAuthenticated(mode === "open" || api.hasToken());
        await refresh();
      } catch {
        if (!cancelled) setError("Cannot connect to server");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Listen for 401s from any api.request — the token has already been
  // cleared in the api layer; reset UI state so the user is bounced back
  // to the login gate without a manual refresh.
  useEffect(() => {
    const onUnauth = () => {
      ++seqRef.current;
      setAuthenticated(authMode === "open");
      setAdminStatus((prev) => (prev ? { ...prev, me: null } : prev));
    };
    window.addEventListener("auth:unauthorized", onUnauth);
    return () => window.removeEventListener("auth:unauthorized", onUnauth);
  }, [authMode]);

  const loginSuccess = useCallback(
    (user?: { email: string; is_admin: boolean }) => {
      const mySeq = ++seqRef.current;
      if (user) {
        setAdminStatus((prev) => ({
          claimed: prev?.claimed ?? true,
          admin: prev?.admin ?? { email: user.email, name: null },
          me: { email: user.email, is_admin: user.is_admin },
        }));
      }
      if (authMode === "key") setAuthenticated(true);
      (async () => {
        try {
          const s = await api.getAdminStatus();
          if (seqRef.current === mySeq) setAdminStatus(s);
        } catch {}
      })();
    },
    [authMode],
  );

  const logout = useCallback(() => {
    api.clearToken();
    setAuthenticated(authMode === "open");
    setAdminStatus((prev) => (prev ? { ...prev, me: null } : prev));
    refresh();
  }, [authMode, refresh]);

  const isAdmin = !!adminStatus?.me?.is_admin;

  return (
    <AuthContext.Provider
      value={{
        authMode,
        adminStatus,
        authenticated,
        isAdmin,
        loading,
        error,
        refresh,
        loginSuccess,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return ctx;
}
