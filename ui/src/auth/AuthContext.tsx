/**
 * AuthContext — single source of truth for browser auth state.
 *
 * Auth is cookie-based: the server sets an httpOnly session cookie on
 * /auth/login, /auth/register, /auth/promptowl. JS cannot read the
 * cookie value; the browser auto-attaches it to same-origin requests.
 * This context derives auth state from `/auth/admin-status` (the only
 * way the client can see "am I logged in").
 *
 * Stale-fetch protection: every refresh bumps a sequence number. Only
 * the latest fetch may write state. Prevents an older in-flight call
 * from clobbering newer state on rapid login/logout cycles.
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
type Me = {
  email: string;
  name: string | null;
  is_admin: boolean;
} | null;

export interface AdminStatus {
  claimed: boolean;
  admin: { email: string; name: string | null } | null;
  me: Me;
}

export type LoginSuccessUser = {
  email: string;
  name?: string | null;
  is_admin: boolean;
};

export interface AuthContextValue {
  authMode: AuthMode;
  adminStatus: AdminStatus | null;
  authenticated: boolean;
  isAdmin: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  loginSuccess: (user?: LoginSuccessUser) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [authMode, setAuthMode] = useState<AuthMode>(null);
  const [adminStatus, setAdminStatus] = useState<AdminStatus | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const seqRef = useRef(0);

  // Derive `authenticated` from whether the server says we have a user.
  // In open mode the server treats every caller as the anonymous admin,
  // so we always render the dashboard regardless of cookie state.
  const deriveAuthenticated = useCallback(
    (mode: AuthMode, me: Me): boolean => {
      if (mode === "open") return true;
      return !!me;
    },
    [],
  );

  const refresh = useCallback(async () => {
    const mySeq = ++seqRef.current;
    try {
      const s = await api.getAdminStatus();
      if (seqRef.current !== mySeq) return;
      setAdminStatus(s);
      // Don't downgrade open-mode to false even if /admin-status returns
      // me:null — authMode is the gate for that.
      setAuthenticated(authMode === "open" ? true : !!s.me);
    } catch {
      /* silent; surfaced via error state elsewhere */
    }
  }, [authMode]);

  useEffect(() => {
    // Clear any token left over from the localStorage era. Cookie-based
    // sessions replaced it; lingering localStorage is dead weight.
    api.clearLegacyLocalStorage();

    let cancelled = false;
    (async () => {
      try {
        const h = await api.getHealth();
        if (cancelled) return;
        const mode = h.auth_mode as AuthMode;
        setAuthMode(mode);

        const status = await api.getAdminStatus();
        if (cancelled) return;
        setAdminStatus(status);
        setAuthenticated(deriveAuthenticated(mode, status.me));
      } catch {
        if (!cancelled) setError("Cannot connect to server");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deriveAuthenticated]);

  // Listen for 401s from any api.request — the server says our session
  // is invalid. Reset state so the user is bounced back to the login
  // gate without a manual refresh.
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
    (user?: LoginSuccessUser) => {
      const mySeq = ++seqRef.current;
      if (user) {
        const name = user.name ?? null;
        setAdminStatus((prev) => ({
          claimed: prev?.claimed ?? true,
          admin: prev?.admin ?? { email: user.email, name },
          me: { email: user.email, name, is_admin: user.is_admin },
        }));
        setAuthenticated(true);
      }
      // Reconcile from server in the background — guarded by seq so a
      // stale response can't overwrite this optimistic flip.
      (async () => {
        try {
          const s = await api.getAdminStatus();
          if (seqRef.current === mySeq) {
            setAdminStatus(s);
            setAuthenticated(deriveAuthenticated(authMode, s.me));
          }
        } catch {
          /* silent */
        }
      })();
    },
    [authMode, deriveAuthenticated],
  );

  const logout = useCallback(async () => {
    ++seqRef.current;
    try {
      await api.logout();
    } catch {
      // Even if the server call fails, treat the client as logged out —
      // the cookie may already be invalid and we don't want a stuck UI.
    }
    setAuthenticated(authMode === "open");
    setAdminStatus((prev) => (prev ? { ...prev, me: null } : prev));
  }, [authMode]);

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
