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
  logoUrl: string | null;
  serverVersion: string | null;
  adminStatus: AdminStatus | null;
  authenticated: boolean;
  isAdmin: boolean;
  /** Public feature flag from /health — the server's route gate, so the UI
   *  hides the workflow plane exactly when the API would 404 it. */
  workflowPlaneEnabled: boolean;
  /** Public feature flag from /health — import teams from PromptOwl (default
   *  OFF). Off → /teams/promptowl 404s, so the UI hides the panel to match. */
  promptowlTeamsEnabled: boolean;
  /** Content-type toggles from /health (default ON). The editor's type picker
   *  hides a disabled type exactly when the API would refuse creating it;
   *  existing nodes of the type stay readable. */
  typeArtifactEnabled: boolean;
  typeTableEnabled: boolean;
  /** Public feature flag from /health — sub-agent (nested) runs. Gated
   *  separately from the plane; when off the UI hides the "spawn sub-agent"
   *  option exactly when the API would reject a parent_run_id (400). */
  subagentRunsEnabled: boolean;
  /** Server's sub-agent recursion caps from /health (env-overridable). The
   *  Runs picker validates against these real values, not hardcoded defaults,
   *  so an operator's override stays in sync with the grey-outs. */
  subagentMaxDepth: number;
  subagentMaxChildren: number;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Re-read the public feature flags from /health and update them live —
   *  call after an admin toggles a flag in Settings so gated UI (workflow
   *  plane, sub-agent runs) reacts without a full page reload. */
  refreshHealth: () => Promise<void>;
  loginSuccess: (user?: LoginSuccessUser) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [authMode, setAuthMode] = useState<AuthMode>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [workflowPlaneEnabled, setWorkflowPlaneEnabled] = useState(false);
  const [promptowlTeamsEnabled, setPromptowlTeamsEnabled] = useState(false);
  // Content types default ON (mirrors config.ts — only an explicit "false"
  // disables), so the picker doesn't flicker types away while /health loads.
  const [typeArtifactEnabled, setTypeArtifactEnabled] = useState(true);
  const [typeTableEnabled, setTypeTableEnabled] = useState(true);
  const [subagentRunsEnabled, setSubagentRunsEnabled] = useState(false);
  // Defaults mirror config.ts; overwritten by /health so operator overrides
  // flow through to the picker.
  const [subagentMaxDepth, setSubagentMaxDepth] = useState(8);
  const [subagentMaxChildren, setSubagentMaxChildren] = useState(16);
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

  const refreshHealth = useCallback(async () => {
    try {
      const h = await api.getHealth();
      setLogoUrl(h.logo_url ?? null);
      setWorkflowPlaneEnabled(!!h.workflow_plane_enabled);
      setPromptowlTeamsEnabled(!!h.promptowl_teams_enabled);
      setTypeArtifactEnabled(h.type_artifact_enabled !== false);
      setTypeTableEnabled(h.type_table_enabled !== false);
      setSubagentRunsEnabled(!!h.subagent_runs_enabled);
      if (typeof h.subagent_max_depth === "number") setSubagentMaxDepth(h.subagent_max_depth);
      if (typeof h.subagent_max_children === "number") setSubagentMaxChildren(h.subagent_max_children);
    } catch {
      /* keep the last-known flags on a transient health failure */
    }
  }, []);

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
        setLogoUrl(h.logo_url ?? null);
        setServerVersion(h.version ?? null);
        setWorkflowPlaneEnabled(!!h.workflow_plane_enabled);
        setPromptowlTeamsEnabled(!!h.promptowl_teams_enabled);
        setTypeArtifactEnabled(h.type_artifact_enabled !== false);
        setTypeTableEnabled(h.type_table_enabled !== false);
        setSubagentRunsEnabled(!!h.subagent_runs_enabled);
        if (typeof h.subagent_max_depth === "number") setSubagentMaxDepth(h.subagent_max_depth);
        if (typeof h.subagent_max_children === "number") setSubagentMaxChildren(h.subagent_max_children);

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

  // Swap browser tab favicon to the operator's custom logo when set.
  // The fallback href in index.html stays as the inline 🪺 SVG.
  useEffect(() => {
    if (!logoUrl) return;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) link.href = logoUrl;
  }, [logoUrl]);

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

  // Cross-tab sync — logout / login in one tab fires a `storage` event in
  // every other tab on the same origin. Refresh from /auth/admin-status
  // so each tab settles to whatever the server says is current.
  //
  // Why this matters in AUTH_MODE=open: the server treats anonymous
  // callers as the open-mode admin, so a logged-out tab still gets 200s
  // on writes. No 401 ever fires, so the existing `auth:unauthorized`
  // signal can't tear down stale admin UI. The storage event closes
  // that gap without polling.
  //
  // The visibilitychange handler is the safety net: any tab that was
  // backgrounded across a logout in another tab will reconcile when
  // it regains focus, even if the storage event was missed (e.g. tab
  // was sleeping under aggressive browser power saving).
  useEffect(() => {
    const KEY = "cnst_auth_tick";
    const onStorage = (e: StorageEvent) => {
      if (e.key !== KEY) return;
      void refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // Notify sibling tabs that auth state changed. Writes a monotonically
  // increasing value to localStorage so the `storage` event fires even
  // when the new value matches the prior one (back-to-back logouts).
  // Same-tab listeners do NOT receive storage events, so the local
  // state update above still has to run independently.
  const broadcastAuthChange = useCallback(() => {
    try {
      localStorage.setItem("cnst_auth_tick", String(Date.now()));
    } catch {
      // Private mode / storage disabled — cross-tab sync degrades to
      // the visibilitychange safety net.
    }
  }, []);

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
      broadcastAuthChange();
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
    [authMode, broadcastAuthChange, deriveAuthenticated],
  );

  const logout = useCallback(async () => {
    ++seqRef.current;
    // If this session was started via OIDC SSO, the server set a readable
    // marker cookie. Route logout through GET /auth/oidc/logout so the IdP
    // session ends too (RP-initiated logout) — otherwise the next "Sign in
    // with SSO" click silently re-authenticates. That endpoint tears the
    // local session down server-side and redirects back to "/", so we hand
    // the whole tab over to it rather than calling api.logout().
    const ssoSession = document.cookie
      .split(";")
      .some((c) => c.trim().startsWith("cnst_sso_session="));
    if (ssoSession) {
      window.location.assign("/auth/oidc/logout");
      return;
    }
    try {
      await api.logout();
    } catch {
      // Even if the server call fails, treat the client as logged out —
      // the cookie may already be invalid and we don't want a stuck UI.
    }
    setAuthenticated(authMode === "open");
    setAdminStatus((prev) => (prev ? { ...prev, me: null } : prev));
    broadcastAuthChange();
  }, [authMode, broadcastAuthChange]);

  const isAdmin = !!adminStatus?.me?.is_admin;

  return (
    <AuthContext.Provider
      value={{
        authMode,
        logoUrl,
        serverVersion,
        adminStatus,
        authenticated,
        isAdmin,
        workflowPlaneEnabled,
        promptowlTeamsEnabled,
        typeArtifactEnabled,
        typeTableEnabled,
        subagentRunsEnabled,
        subagentMaxDepth,
        subagentMaxChildren,
        loading,
        error,
        refresh,
        refreshHealth,
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
