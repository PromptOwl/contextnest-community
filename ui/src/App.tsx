import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Login } from "./components/Login";
import { NestView } from "./components/NestView";
import { DocumentEditor } from "./components/DocumentEditor";
import { DocumentSidebar } from "./components/DocumentSidebar";
import { ConnectModal } from "./components/ConnectModal";
import { readDocPagePrefs, writeDocPagePrefs } from "./lib/doc-page";
import { AdminLoginModal } from "./components/AdminLoginModal";
import { TeammatesPage } from "./components/TeammatesPage";
import { ApiKeysPage } from "./components/ApiKeysPage";
import { TeamsPage } from "./components/TeamsPage";
import { SettingsPage } from "./components/SettingsPage";
import { GuidePage } from "./components/GuidePage";
import { LicenseSetupPage } from "./components/LicenseSetupPage";
import { getLicenseStatus, getNest, changePassword, getAdminSettings, updateAdminSettings, type LicenseStatus, type AdminSettings } from "./lib/api";
import { QuickOpen, type QuickOpenResult } from "./components/QuickOpen";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { useQueryClient } from "@tanstack/react-query";
import { reads } from "./lib/queries";
import { ANON_USER_ID } from "./lib/constants";
import { navigateGuarded } from "./lib/nav-guard";
import { track } from "./lib/analytics";
import { nestIdFromLocation, nestPath, nestViewFromLocation } from "./lib/nest-url";
import { nestPageForPath, nestPageForView, nestPages } from "./lib/nest-pages";
import { NestPageProvider } from "./lib/nest-page-context";
import { dashboardPage, dashboardPageIdFromPath, dashboardPath, DEFAULT_PAGE_ID } from "./lib/pages";
import { AppNavProvider, type AppNav } from "./lib/app-nav";
import { useBreadcrumbTail, type Crumb } from "./lib/breadcrumb";
import {
  deriveNestCaps,
  isReaderHiddenView,
  isViewBlockedInReaderMode,
} from "./lib/nest-caps";
import hootieIcon from "./assets/hootie.svg";
import { Shield, Info, Users, ChevronDown, LogOut, KeyRound, Eye, EyeOff, BookOpen, ScrollText, Activity, Search, FileText, Keyboard, PanelLeft, ChevronRight } from "lucide-react";
import { AgentDocsPage } from "./components/AgentDocsPage";
import { ActivityTracePage } from "./components/ActivityTracePage";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BetaBadge } from "@/components/ui/beta-badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  | {
      page: "dashboard";
      /** A dashboard page id (its folder under pages/dashboard); omitted = nests. */
      tab?: string;
    }
  | {
      page: "nest";
      nestId: string;
      nestName: string;
      isOwner: boolean;
      isAnonOwned: boolean;
      /** Nest is archived — opened from the Archived section, read-only. */
      isArchived?: boolean;
      /** Seed the nest list's search filter when arriving via a tag
       *  click on a document detail page. */
      initialSearch?: string;
      /** Pre-scope the nest list when arriving from a tag chip or a folder
       *  breadcrumb segment on a document/graph page. */
      initialTags?: string[];
      initialFolder?: string;
      /** Which of NestView's own tabs is open, mirrored to ?tab= so a link
       *  to the Review Queue lands on the Review Queue. Absent = overview. */
      tab?: string;
      /** Public Docs Reader Mode is on for this nest AND the caller is
       *  read-only — the shell hides the board/graph/definitions tabs and
       *  NestView renders the stripped ReaderView. */
      readerMode?: boolean;
      /** Reader mode: the page open in the reader, mirrored to ?doc= so a
       *  public page is a shareable link that lands inside the docs layout. */
      readerDoc?: string;
    }
  | {
      page: "document";
      nestId: string;
      nestName: string;
      nodeId: string | "new";
      isOwner: boolean;
      isAnonOwned: boolean;
      /** Pre-file a NEW doc into this folder (folder-tree + buttons). */
      initialFolder?: string;
      /** Pre-fill the title when arriving via a broken-wikilink click.
       *  Only meaningful when nodeId === "new". */
      initialTitle?: string;
      /** Prior wiki-link hops, oldest first. Back pops the last entry. */
      breadcrumb?: BreadcrumbEntry[];
      /** Open with this comment thread focused (activity-feed deep link;
       *  also arrives via the ?thread= URL param). */
      initialThreadId?: string;
    }
  | { page: "api-keys" }
  | { page: "teammates" }
  | { page: "teams" }
  | { page: "settings" }
  | { page: "guide" }
  | { page: "trace" }
  | { page: "docs" }
  | {
      page: "ontology-graph";
      nestId: string;
      nestName: string;
      isOwner: boolean;
      isAnonOwned: boolean;
      readerMode?: boolean;
      /** Nest is archived — opened from the Archived section, read-only. */
      isArchived?: boolean;
    }
  | {
      page: "workflows";
      nestId: string;
      nestName: string;
      isOwner: boolean;
      isAnonOwned: boolean;
      readerMode?: boolean;
      /** Nest is archived — opened from the Archived section, read-only. */
      isArchived?: boolean;
    }
  | {
      page: "definitions";
      nestId: string;
      nestName: string;
      isOwner: boolean;
      isAnonOwned: boolean;
      readerMode?: boolean;
      /** Nest is archived — opened from the Archived section, read-only. */
      isArchived?: boolean;
    }
  | {
      page: "board";
      nestId: string;
      nestName: string;
      isOwner: boolean;
      isAnonOwned: boolean;
      readerMode?: boolean;
      /** Nest is archived — opened from the Archived section, read-only. */
      isArchived?: boolean;
    }
  | {
      /** Nest-scoped activity trace (owner/nest-admin) — ActivityTracePage
       *  in nest mode, backed by GET /nests/:id/trace. */
      page: "nest-trace";
      nestId: string;
      nestName: string;
      isOwner: boolean;
      isAnonOwned: boolean;
      readerMode?: boolean;
    };

/** The views of a single nest, in switcher order: the nest page ("Nest", not
 *  "Documents" — it has its own Documents tab) then the registry pages. */
const NEST_VIEWS = [
  { page: "nest" as const, label: "Nest", icon: FileText, beta: false },
  ...nestPages.map((p) => ({ page: p.viewPage, label: p.label, icon: p.icon, beta: !!p.beta })),
];

/** NestView's own tab slugs — the whitelist for ?tab=. Some are permission
 *  gated inside NestView, which falls back to overview when one isn't shown. */
/** Breadcrumb labels for those tabs. */
const NEST_TAB_LABELS: Record<string, string> = {
  overview: "Overview",
  documents: "Documents",
  review: "Review queue",
  "external-edits": "External edits",
  stewards: "Stewards",
  collaborators: "Collaborators",
};

const NEST_TABS = [
  "overview",
  "documents",
  "review",
  "external-edits",
  "stewards",
  "collaborators",
];

type NestScopedView = Extract<View, { page: "nest" | "board" | "ontology-graph" | "definitions" | "workflows" }>;

const isNestScoped = (view: View): view is NestScopedView =>
  NEST_VIEWS.some((v) => v.page === view.page);

// Runs the ?sso_error toast exactly once per page load (survives React
// StrictMode's dev double-mount). Resets naturally on the next full navigation.
let ssoErrorHandled = false;

export default function App() {
  const {
    authMode,
    logoUrl,
    serverVersion,
    adminStatus,
    authenticated,
    isAdmin,
    workflowPlaneEnabled,
    subagentRunsEnabled,
    refreshHealth,
    loading,
    error,
    logout,
  } = useAuth();
  const [view, setViewNow] = useState<View>(() => ({
    page: "dashboard",
    // /my-work and /my-drafts open straight onto their page.
    ...(typeof window !== "undefined"
      ? { tab: dashboardPageIdFromPath(window.location.pathname) ?? DEFAULT_PAGE_ID }
      : {}),
  }));
  // Every view change asks the mounted screen first — an editor holding
  // unsaved edits answers with its leave dialog instead of losing them. The
  // guard is a no-op anywhere that registered none, so call sites are unchanged.
  const setView = useCallback(
    (next: View) => navigateGuarded(() => setViewNow(next)),
    [],
  );
  // Route views for product analytics. The SPA keeps one URL, so the view is
  // the event property; no-op unless the server configured a PostHog key.
  useEffect(() => {
    track("$pageview", { page: view.page });
  }, [view.page]);
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  // /nest/<id> (or legacy ?nest=<id>) deep-link probe; 200 → skip Login,
  // mount NestView.
  // "missing" is "no ?nest to open"; "unreachable" is "there was one and it
  // didn't resolve" — a deleted nest, a typo'd id, or access that was revoked.
  // They render differently: only the second one owes the user an explanation.
  const [deepLinkProbe, setDeepLinkProbe] = useState<
    | { status: "idle" }
    // The id being probed, once it is no longer readable from the URL: an
    // unresolved ?nest is cleared from the address bar (CU-wdqcq01e70), so
    // "Try again" carries it in state instead.
    | { status: "loading"; nestId?: string }
    | { status: "ok"; nestId: string; nestName: string }
    | { status: "missing" }
    | { status: "unreachable"; nestId: string }
  >(() => {
    if (typeof window === "undefined") return { status: "idle" };
    return nestIdFromLocation() ? { status: "loading" } : { status: "idle" };
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
  // Server-wide settings for the admin Settings page. Loaded once for admins.
  const [serverSettings, setServerSettings] = useState<AdminSettings | null>(null);
  useEffect(() => {
    if (!isAdmin) return;
    getAdminSettings()
      .then(setServerSettings)
      .catch(() => {});
  }, [isAdmin]);
  const updateServerSettings = useCallback(async (
    patch: Partial<AdminSettings> & { anthropic_api_key?: string | null },
  ) => {
    try {
      const res = await updateAdminSettings(patch);
      setServerSettings(res.settings);
      // Feature flags gate other views (workflow-plane nav, sub-agent picker,
      // PromptOwl teams …) off the /health-sourced AuthContext state, not
      // serverSettings. Always re-read health after a save so ANY flag exposed
      // there takes effect live — no page reload, and no per-key allowlist to
      // keep in sync as new flags are added.
      await refreshHealth();
      toast.success("Settings saved");
    } catch (e: any) {
      toast.error(e?.message || "Failed to save settings");
      // A rejected save (validation / SMTP verify) persisted nothing server-side,
      // so DON'T re-sync — that would reset the draft and wipe what the admin
      // typed. Re-throw the original error (with its `body.fieldErrors`) so the
      // Settings page can focus the offending field's tab and show the message.
      throw e;
    }
  }, [refreshHealth]);
  // Cmd/Ctrl+K quick-open — active anywhere inside a nest context.
  const [showQuickOpen, setShowQuickOpen] = useState(false);
  // The document page's index rail. Per-browser; the page itself offers the
  // toggle (sidebar header to hide, top bar to show).
  const [docSidebarCollapsed, setDocSidebarCollapsedState] = useState(
    () => readDocPagePrefs(localStorage).sidebarCollapsed,
  );
  const setDocSidebarCollapsed = (collapsed: boolean) => {
    setDocSidebarCollapsedState(collapsed);
    writeDocPagePrefs(localStorage, { sidebarCollapsed: collapsed });
  };
  // Below md the rail is a drawer over the document instead of a column
  // beside it; that open/closed state is transient, never persisted.
  const [docSidebarDrawer, setDocSidebarDrawer] = useState(false);
  useEffect(() => {
    setDocSidebarDrawer(false);
  }, [view]);
  // Connect (CLI / MCP / API setup for this nest) from the sidebar — the nest
  // page has its own button; this one serves every other nest page.
  const [showConnect, setShowConnect] = useState(false);

  const requestLogout = useCallback(() => setLogoutConfirm(true), []);

  const qc = useQueryClient();
  // A search hit names its nest but says nothing about the caller's standing in
  // it, which both the nest and document views need. Read that off the cached
  // nest list (already loaded by the dashboard behind the palette) rather than
  // shipping permission reasoning through the search response.
  const openSearchHit = useCallback(
    async (result: QuickOpenResult) => {
      const list = await qc.fetchQuery(reads.nestList()).catch(() => null);
      const nestId = result.kind === "nest" ? result.id : result.nest_id!;
      const nest = (list as any)?.nests?.find((n: any) => n.id === nestId);
      const caps = {
        isOwner: nest?.is_owner ?? false,
        isAnonOwned: nest?.user_id === ANON_USER_ID,
      };
      const nestName = result.kind === "nest" ? result.title : result.nest_name!;
      setView(
        result.kind === "nest"
          ? { page: "nest", nestId, nestName, ...caps }
          : { page: "document", nestId, nestName, nodeId: result.id, ...caps },
      );
    },
    [qc],
  );

  // Only bound where QuickOpen can actually render — inside a nest (scoped to
  // it) or on the dashboard (across every nest). Anywhere else the shortcut
  // used to flip the flag with nothing mounted to show it, so the panel sprang
  // open on the next nest you entered — hence the reset on leaving too.
  const canQuickOpen =
    view.page === "nest" || view.page === "document" || view.page === "dashboard";
  useEffect(() => {
    if (!canQuickOpen) {
      setShowQuickOpen(false);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowQuickOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canQuickOpen]);

  // `?` opens the shortcut cheatsheet — but only when it isn't a character
  // being typed, so it never eats a question mark in a document or a field.
  const [showShortcuts, setShowShortcuts] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (
        el?.isContentEditable ||
        el?.tagName === "INPUT" ||
        el?.tagName === "TEXTAREA" ||
        el?.tagName === "SELECT"
      )
        return;
      e.preventDefault();
      setShowShortcuts(true);
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
    // A retry re-probes the id it failed on, which is no longer in the URL.
    const nestId = deepLinkProbe.nestId ?? nestIdFromLocation();
    if (!nestId) {
      setDeepLinkProbe({ status: "missing" });
      return;
    }
    // ?view=workflows is the one sub-page gated on a flag that arrives with
    // /health. Deciding before it lands read the flag as its `false` default
    // and silently dropped the parameter — the probe then settled on "ok", so
    // the re-run below found nothing left to do and the link opened Overview.
    // Wait for health for that link only; every other view resolves at once.
    if (loading && nestViewFromLocation() === "workflows") return;
    // Re-runs if workflowPlaneEnabled resolves mid-probe (health may land after
    // this effect first fires); the cancel guard drops the stale navigation.
    let cancelled = false;
    (async () => {
      try {
        const { nest, permission, roles, myStewards } = await getNest(nestId);
        if (cancelled) return;
        // Deep-link / refresh nav has no is_owner from a nest-list row, so
        // derive it from the authoritative permission — resolveNestPermission
        // returns "owner" only for the real owner. Hardcoding false here hid
        // owner-only UI (Nest settings) after a refresh, even for the owner.
        const isOwner = permission === "owner";
        // Public Docs Reader Mode strips the shell tabs (board/graph/
        // definitions) and swaps NestView for the docs reader — but ONLY for a
        // read-only caller. Owners/editors/reviewers/admins keep authoring.
        const readerMode = deriveNestCaps({
          roles: roles ?? [],
          permission,
          myStewards: (myStewards ?? []) as any,
          isOwner,
          isAdmin,
          readerMode: !!nest.reader_mode,
        }).isReaderView;
        setDeepLinkProbe({
          status: "ok",
          nestId: nest.id,
          nestName: nest.name,
        });
        // ?doc=<nodeId> → open that document directly (the doc view's own
        // load surfaces a not-found error if the id is stale).
        const docId = params.get("doc");
        // In reader mode a doc link opens INSIDE the docs layout (nav +
        // outline), not the bare document page a collaborator would get.
        if (docId && docId !== "new" && readerMode) {
          setView({
            page: "nest",
            nestId: nest.id,
            nestName: nest.name,
            isOwner,
            isAnonOwned: false,
            readerMode,
            readerDoc: docId,
          });
          return;
        }
        if (docId && docId !== "new") {
          setView({
            page: "document",
            nestId: nest.id,
            nestName: nest.name,
            nodeId: docId,
            isOwner,
            isAnonOwned: false,
            // ?thread=<id> → open the doc with that comment thread focused.
            initialThreadId: params.get("thread") || undefined,
          });
          return;
        }
        // ?view=<sub> → land on a nest-scoped sub-page (shareable deep link).
        // edge-types stays gated on the flag so a shared link can't reach a
        // plane the server has disabled — it falls back to the nest view.
        // The view rides in the path (/nest/<id>/<segment>), legacy ?view= still
        // read. Registry pages resolve through their meta; a page whose gate
        // fails (workflows without the flag) falls back to the nest view.
        const sub = nestViewFromLocation();
        const subMeta = nestPageForPath(sub);
        const subPage =
          subMeta
            ? subMeta.visible && !subMeta.visible({ isReadOnly: false, isReaderView: false, canEditDocs: true, workflowPlaneEnabled })
              ? null
              : subMeta.viewPage
            : sub === "trace" ? "nest-trace"
            : null;
        // In reader mode the board / ontology-graph / definitions pages are
        // hidden — a deep link into one must not enter it (the tab is gone, but
        // the page state is top-level and would otherwise render the full
        // authoring view). Fall back to the nest page, same as an unknown ?tab.
        if (subPage && isViewBlockedInReaderMode(subPage, readerMode)) {
          setView({
            page: "nest",
            nestId: nest.id,
            nestName: nest.name,
            isOwner,
            isAnonOwned: false,
            readerMode,
          });
          return;
        }
        if (subPage) {
          setView({
            page: subPage,
            nestId: nest.id,
            nestName: nest.name,
            isOwner,
            isAnonOwned: false,
            readerMode,
          });
          return;
        }
        setView({
          page: "nest",
          nestId: nest.id,
          nestName: nest.name,
          isOwner,
          isAnonOwned: false,
          readerMode,
          // ?tab=<slug> → open on that NestView tab. Unknown slugs are
          // dropped rather than passed through, so a stale link can't leave
          // Radix with a value that matches no trigger (blank content area).
          tab: NEST_TABS.includes(params.get("tab") ?? "")
            ? params.get("tab")!
            : undefined,
        });
      } catch {
        if (!cancelled) setDeepLinkProbe({ status: "unreachable", nestId });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deepLinkProbe.status, workflowPlaneEnabled, loading]);

  // Keep the URL in sync with the current view so documents (and nests) are
  // shareable — paste the address bar and the recipient lands on the same doc.
  // The probe above consumes ?nest / ?doc on load, so we must NOT rewrite the
  // URL while it's still "loading", or we'd clobber the params before it reads
  // them. ?doc is omitted for unsaved ("new") documents.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (deepLinkProbe.status === "loading") return;
    // An unresolved ?nest is dropped from the address bar as soon as its error
    // screen goes up (CU-wdqcq01e70): leaving it there made every refresh — and
    // any link copied off that screen — land back on the same dead end. The id
    // rides in the probe state instead, so "Try again" still has one.
    const params = new URLSearchParams(window.location.search);
    // The nest rides in the path (/nest/<id>), never the query — a legacy
    // ?nest= that got us here is dropped once the path form is written.
    params.delete("nest");
    let pathNestId: string | null = null;
    let pathView: string | null = null;
    if (view.page === "document") {
      pathNestId = view.nestId;
      if (view.nodeId && view.nodeId !== "new") params.set("doc", view.nodeId);
      else params.delete("doc");
      // Keep the focused-thread deep link shareable; drop it otherwise so a
      // stale ?thread doesn't leak onto the next document.
      if (view.initialThreadId) params.set("thread", view.initialThreadId);
      else params.delete("thread");
      params.delete("view");
      params.delete("tab");
    } else if (view.page === "nest") {
      pathNestId = view.nestId;
      if (view.readerMode && view.readerDoc) params.set("doc", view.readerDoc);
      else params.delete("doc");
      params.delete("thread");
      params.delete("view");
      // Overview is the default, so it stays out of the URL — a plain ?nest
      // link keeps working and doesn't grow a redundant &tab=overview.
      if (view.tab && view.tab !== "overview") params.set("tab", view.tab);
      else params.delete("tab");
    } else if (
      // Nest views ride in the path (/nest/<id>/<segment>) — the registry
      // page owns its segment; trace is the one non-registry sub-page.
      view.page === "ontology-graph" ||
      view.page === "workflows" ||
      view.page === "definitions" ||
      view.page === "board" ||
      view.page === "nest-trace"
    ) {
      pathNestId = view.nestId;
      pathView = view.page === "nest-trace" ? "trace" : nestPageForView(view.page)?.path ?? null;
      params.delete("doc");
      params.delete("thread");
      params.delete("tab");
      params.delete("view");
    } else {
      params.delete("doc");
      params.delete("thread");
      params.delete("view");
      params.delete("tab");
    }
    const qs = params.toString();
    const path =
      view.page === "dashboard" ? dashboardPath(view.tab) : nestPath(pathNestId, pathView);
    const next = path + (qs ? `?${qs}` : "") + window.location.hash;
    const current =
      window.location.pathname + window.location.search + window.location.hash;
    if (next !== current) {
      window.history.replaceState({}, "", next);
    }
  }, [view, deepLinkProbe.status]);

  // Reader mode is a property of the nest and the caller, not of how the user
  // navigated here. The deep-link probe seeds view.readerMode for the first
  // paint; the nest-scoped fetch below resolves it for every other entry point
  // (dashboard, back arrow, wiki-link nav), which never carried it.
  const [nestIsReaderView, setNestIsReaderView] = useState<boolean | null>(null);
  const readerMode = isNestScoped(view)
    ? (nestIsReaderView ?? view.readerMode ?? false)
    : false;

  // Reader-mode render guard: the board / ontology-graph / definitions pages
  // are hidden in reader mode, but they are top-level view.page states, so a
  // reader who reaches one another way (a stale in-app link, a restored state)
  // would otherwise land on the full authoring page. Redirect to the nest page
  // — the deep-link probe already blocks the URL entry point; this closes the
  // remaining paths. The render conditionals also require !readerMode, so
  // the hidden page never paints for the frame before this effect corrects it.
  useEffect(() => {
    if (
      isNestScoped(view) &&
      isViewBlockedInReaderMode(view.page, readerMode)
    ) {
      setView({
        page: "nest",
        nestId: view.nestId,
        nestName: view.nestName,
        isOwner: view.isOwner,
        isAnonOwned: view.isAnonOwned,
        readerMode,
      });
    }
  }, [view, readerMode]);

  // Caller's write access on the nest currently in view, for gating the
  // Workflows tab (an execution plane — every action inside it mutates).
  // null = not resolved yet; the tab stays hidden until we know, so a viewer
  // never sees it flash. getNest is cached, so this shares NestView's fetch.
  // "nestId" in view: the five switcher pages plus the document and trace
  // pages — the sidebar shows on all of them and needs the same caps.
  const nestScopedId = "nestId" in view ? view.nestId : null;
  const nestScopedIsOwner = "nestId" in view ? view.isOwner : false;
  const [nestCanEdit, setNestCanEdit] = useState<boolean | null>(null);
  useEffect(() => {
    setNestCanEdit(null);
    setNestIsReaderView(null);
    if (!nestScopedId) return;
    let cancelled = false;
    getNest(nestScopedId)
      .then((meta: any) => {
        if (cancelled) return;
        const caps = deriveNestCaps({
          roles: meta?.roles ?? [],
          permission: meta?.permission ?? null,
          myStewards: meta?.myStewards ?? [],
          isOwner: nestScopedIsOwner,
          isAdmin,
          readerMode: !!meta?.nest?.reader_mode,
        });
        setNestCanEdit(caps.canEditDocs);
        setNestIsReaderView(caps.isReaderView);
      })
      .catch(() => {
        if (cancelled) return;
        setNestCanEdit(false);
        setNestIsReaderView(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nestScopedId, nestScopedIsOwner, isAdmin]);

  // A read-only caller who deep-links ?view=workflows would otherwise sit on a
  // page whose tab isn't in the strip. Bounce once caps actually resolve —
  // never while they're still null, or writers would get bounced mid-load.
  useEffect(() => {
    if (view.page === "workflows" && nestCanEdit === false) {
      setView({
        page: "nest",
        nestId: view.nestId,
        nestName: view.nestName,
        isOwner: view.isOwner,
        isAnonOwned: view.isAnonOwned,
      });
    }
  }, [view, nestCanEdit]);

  // Header breadcrumb. App owns the base — Home, and the nest when inside
  // one — from the view; the page owns the tail through useBreadcrumb()
  // (the document page passes its title). A page that set nothing gets an
  // automatic leaf: the registry label on the dashboard, the view's name in
  // a nest. Only the dashboard's root page has no "Home" in front of it.
  const pageTail = useBreadcrumbTail();
  const crumbs = useMemo<Crumb[]>(() => {
    const home: Crumb = { label: "Home", go: () => setView({ page: "dashboard" }) };
    if (view.page === "dashboard") {
      const page = dashboardPage(view.tab);
      if (pageTail.length) return [home, ...pageTail];
      return page.id === DEFAULT_PAGE_ID ? [{ label: page.label }] : [home, { label: page.label }];
    }
    if ("nestId" in view) {
      const nest: Crumb = {
        label: view.nestName,
        go: () =>
          setView({
            page: "nest",
            nestId: view.nestId,
            nestName: view.nestName,
            isOwner: view.isOwner,
            isAnonOwned: view.isAnonOwned,
            tab: "overview",
          }),
      };
      if (pageTail.length) return [home, nest, ...pageTail];
      const leaf =
        view.page === "nest"
          ? NEST_TAB_LABELS[view.tab ?? "overview"] ?? "Overview"
          : view.page === "document" ? "Document"
          : view.page === "nest-trace" ? "Trace"
          : nestPageForView(view.page)?.label ?? "";
      return [home, nest, { label: leaf }];
    }
    return pageTail.length ? [home, ...pageTail] : [];
  }, [view, setView, pageTail]);

  // What a dashboard page can do to the app. Pages read it with useAppNav()
  // instead of props, so App renders every page the same way.
  const appNav = useMemo<AppNav>(
    () => ({
      openNest: (id, name, isOwner, isAnonOwned, isArchived) =>
        setView({ page: "nest", nestId: id, nestName: name, isOwner, isAnonOwned, isArchived }),
      openReview: (nestId, nestName, nodeId) =>
        setView({ page: "document", nestId, nestName, nodeId, isOwner: true, isAnonOwned: true }),
      manageKeys: () => setView({ page: "api-keys" }),
    }),
    [setView],
  );

  // Back out of the nest entirely. Shared by all five nest-scoped pages —
  // their back arrows used to return to the nest page, but the view switcher
  // makes that a tab click, so back now means "leave this nest".
  const leaveNest = useCallback(() => {
    // Drop the nest from the URL so refresh doesn't re-enter it.
    if (typeof window !== "undefined" && nestIdFromLocation()) {
      const params = new URLSearchParams(window.location.search);
      params.delete("nest");
      const qs = params.toString();
      window.history.replaceState(
        {},
        "",
        nestPath(null) + (qs ? `?${qs}` : "") + window.location.hash,
      );
    }
    // Unauth → bounce to Login (Dashboard would 401).
    if (!authenticated && authMode === "key") {
      setDeepLinkProbe({ status: "missing" });
    }
    setView({ page: "dashboard" });
  }, [authenticated, authMode]);

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
      // OIDC SSO (GET /auth/oidc/*) reuses the same ?sso_error= channel.
      disabled: "Single sign-on is turned off on this server.",
      not_configured: "Single sign-on isn't fully configured. Contact your admin.",
      discovery_failed: "Couldn't reach the identity provider. Try again, or contact your admin.",
      provider_error: "Your identity provider declined the sign-in. Try again.",
      state_mismatch: "The sign-in attempt expired or didn't match this browser. Try again.",
      exchange_failed: "Sign-in couldn't be completed with the identity provider. Try again.",
      invalid_token: "The identity provider returned an invalid sign-in token. Try again.",
      domain_not_allowed: "Your email domain isn't allowed on this server. Contact your admin.",
      email_not_verified: "Your identity provider reports your email address as unverified. Verify it with your provider, then try again.",
      not_invited: "No account exists for your email on this server. Ask your admin for an invite.",
    };
    const msg = messages[code] ?? "Sign-in failed. Please try again.";
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
      // Not a navigation the user can be asked about — the session it belonged
      // to is already gone, so it skips the leave guard.
      setViewNow({ page: "dashboard" });
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
      // Branded, and worded as loading: a bare "Connecting..." on a blank page
      // read as a connection fault rather than a normal boot (CU-wdqcpzzzrr).
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 animate-pulse">
          <img src={logoUrl ?? hootieIcon} alt="" className="h-10 w-10" />
          <span className="text-sm font-medium">ContextNest</span>
          <span className="text-xs text-muted-foreground">Loading your nests…</span>
        </div>
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

      {/* One palette for both scopes: inside a nest it starts scoped to that
          nest and can widen to every nest, so the pick has to open whichever
          nest the row came from — openSearchHit does that for both. */}
      {showQuickOpen && canQuickOpen && (
        <QuickOpen
          nestId={
            view.page === "nest" || view.page === "document"
              ? view.nestId
              : undefined
          }
          nestName={
            view.page === "nest" || view.page === "document"
              ? view.nestName
              : undefined
          }
          onClose={() => setShowQuickOpen(false)}
          onSelect={(nodeId, result) => {
            setShowQuickOpen(false);
            // A hit in the nest you are already in keeps the standing you were
            // admitted with (a public deep link isn't in the nest list, so
            // re-resolving it there would drop those capabilities).
            if (
              (view.page === "nest" || view.page === "document") &&
              result.kind === "node" &&
              (result.nest_id ?? view.nestId) === view.nestId
            ) {
              setView({
                page: "document",
                nestId: view.nestId,
                nestName: view.nestName,
                nodeId,
                isOwner: view.isOwner,
                isAnonOwned: view.isAnonOwned,
              });
              return;
            }
            void openSearchHit(result);
          }}
        />
      )}
      {/* Sits with the other always-mounted chrome so `?` works on every
          screen, not only inside a nest (CU-wdqcpzzzvk). */}
      {showShortcuts && (
        <ShortcutsDialog onClose={() => setShowShortcuts(false)} />
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

  // Board columns are fixed-width and scroll sideways, so the 6xl shell forces
  // horizontal scrolling long before the viewport runs out. Widen the whole
  // shell (header, tabs, main, footer) on that page so they stay aligned.
  // The document page is its own workspace — a sidebar and a document that
  // manage their own width — so the shell goes edge to edge there.
  const isDocPage = view.page === "document";
  // The nest sidebar (nests → views → documents) wraps every page inside a
  // nest — document, nest, board, graph, definitions, workflows, trace — so
  // moving between them never drops the index. Reader mode keeps its own
  // three-pane reader instead.
  const inNest = "nestId" in view && nestIsReaderView !== true;
  // The dashboard gets the same rail (every nest, none expanded) — it's the
  // app's navigation, not the nest's.
  const withSidebar = inNest || view.page === "dashboard";
  const showSidebar = withSidebar && (!docSidebarCollapsed || docSidebarDrawer);
  const pageWidth =
    view.page === "board" ? "max-w-[1800px]" : "max-w-6xl";
  // Beside the sidebar the shell fills its flex column: `w-full`, and no
  // `mx-auto` — auto margins on a flex-column item shrink it to its content.
  // Without a sidebar the old centred page width applies.
  const shellWidth = withSidebar ? "w-full max-w-none" : `${pageWidth} mx-auto`;

  return (
    <div className={withSidebar ? "flex min-h-screen items-stretch bg-background" : "min-h-screen bg-background"}>
      {/* The sidebar is a full-height column beside the whole shell — header
          included — with the brand at its top, so header and rail read as one
          surface. The unreachable-nest screen keeps the plain shell. */}
      {withSidebar && deepLinkProbe.status !== "unreachable" && (
        <>
        {withSidebar && docSidebarDrawer && (
          <button
            type="button"
            className="fixed inset-0 z-40 bg-black/30 md:hidden"
            aria-label="Close sidebar"
            onClick={() => setDocSidebarDrawer(false)}
          />
        )}
        {showSidebar && (() => {
          const cur = view;
          const nestOf = (v: typeof cur) => ("nestId" in v ? v : null);
          return (
            <div
              className={
                docSidebarDrawer
                  ? "fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] border-r bg-background shadow-xl md:static md:z-auto md:w-64 md:max-w-none md:shadow-none"
                  : "hidden w-64 shrink-0 border-r md:block"
              }
            >
              <div className="sticky top-0 h-screen max-h-screen">
                <DocumentSidebar
                  logoUrl={logoUrl ?? hootieIcon}
                  nestId={nestOf(cur)?.nestId ?? null}
                  nodeId={cur.page === "document" ? cur.nodeId : null}
                  activeView={
                    cur.page === "nest"
                      ? cur.tab === "review"
                        ? "review"
                        : "overview"
                      : nestPageForView(cur.page)?.id ?? null
                  }
                  onCollapse={() =>
                    docSidebarDrawer
                      ? setDocSidebarDrawer(false)
                      : setDocSidebarCollapsed(true)
                  }
                  onOpenDashboard={() => setView({ page: "dashboard" })}
                  dashboardTab={cur.page === "dashboard" ? (cur.tab ?? DEFAULT_PAGE_ID) : null}
                  onOpenDashboardTab={(tab) => setView({ page: "dashboard", tab })}
                  onOpenNest={(t) =>
                    setView({
                      page: "nest",
                      nestId: t.nestId,
                      nestName: t.nestName,
                      isOwner: t.isOwner,
                      isAnonOwned: t.isAnonOwned,
                      tab: "documents",
                    })
                  }
                  onOpenView={(t, v) =>
                    setView({
                      page: v.page,
                      nestId: t.nestId,
                      nestName: t.nestName,
                      isOwner: t.isOwner,
                      isAnonOwned: t.isAnonOwned,
                      readerMode,
                      ...(v.page === "nest" && v.tab ? { tab: v.tab } : {}),
                    } as View)
                  }
                  onConnect={() => setShowConnect(true)}
                  onOpenDocument={(t) => {
                    if (
                      cur.page === "document" &&
                      t.nestId === cur.nestId &&
                      t.nodeId === cur.nodeId
                    )
                      return;
                    setView({
                      page: "document",
                      nestId: t.nestId,
                      nestName: t.nestName,
                      nodeId: t.nodeId,
                      isOwner: t.isOwner,
                      isAnonOwned: t.isAnonOwned,
                    });
                  }}
                  onNewDocument={
                    !("nestId" in cur) || (cur.page === "document" && cur.nodeId === "new")
                      ? undefined
                      : (folder?: string) =>
                          setView({
                            page: "document",
                            nestId: cur.nestId,
                            nestName: cur.nestName,
                            nodeId: "new",
                            isOwner: cur.isOwner,
                            isAnonOwned: cur.isAnonOwned,
                            initialFolder: folder,
                          })
                  }
                />
              </div>
            </div>
          );
        })()}
        </>
      )}
      <div className={withSidebar ? "flex min-w-0 flex-1 flex-col" : ""}>
      {/* Header */}
      <header className="bg-card">
        {/* The divider sits under the top row, not under the tabs — the tab
            row reads as part of the page below it, not a second bar. */}
        <div className="border-b border-border">
        <div className={`${shellWidth} h-16 px-4 flex items-center justify-between`}>
          <div className="flex items-center gap-1">
          {/* The sidebar toggle lives in the app header so it exists on every
              page that has a sidebar: always on a phone (the rail is a drawer
              there), on a desktop only once the rail has been hidden. */}
          {withSidebar && (
            <Button
              variant="ghost"
              size="icon"
              className={`h-8 w-8 shrink-0${showSidebar ? " md:hidden" : ""}`}
              title="Show sidebar"
              aria-label="Show sidebar"
              data-testid="nest-sidebar-expand"
              onClick={() => {
                if (window.matchMedia("(max-width: 767px)").matches)
                  setDocSidebarDrawer(true);
                else setDocSidebarCollapsed(false);
              }}
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
          )}
          <button
            onClick={() => setView({ page: "dashboard" })}
            className={`flex items-center gap-2 hover:opacity-80${showSidebar ? " md:hidden" : ""}`}
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
          {withSidebar && crumbs.length > 0 && (
            <nav aria-label="Breadcrumb" className="ml-1 flex min-w-0 items-center gap-1 text-sm" data-testid="header-breadcrumb">
              {crumbs.map((c, i) => {
                const last = i === crumbs.length - 1;
                return (
                  <span key={i} className="flex min-w-0 items-center gap-1">
                    {i > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" aria-hidden />}
                    {last || !c.go ? (
                      <span className={last ? "truncate text-base font-semibold" : "truncate text-muted-foreground"} aria-current={last ? "page" : undefined}>{c.label}</span>
                    ) : (
                      <button type="button" onClick={c.go} className="truncate text-muted-foreground hover:text-foreground">{c.label}</button>
                    )}
                  </span>
                );
              })}
            </nav>
          )}
          </div>

          <div className="flex items-center gap-2">
            {/* The ONE search entry point, on every page the palette works on
                — the Dashboard used to carry its own field-styled button, so
                the same feature looked like two (CU-wdqcq012uv). What differs
                between pages is scope, and the palette states that itself. */}
            {canQuickOpen && (
              <button
                onClick={() => setShowQuickOpen(true)}
                title={
                  view.page === "dashboard"
                    ? "Search nests and documents (⌘K)"
                    : "Search this nest (⌘K)"
                }
                className="flex items-center gap-2 h-8 pl-2.5 pr-2 rounded-md border border-input bg-background text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                data-testid="global-search-trigger"
              >
                <Search className="h-3.5 w-3.5" />
                <span>Search</span>
                <kbd className="ml-1 hidden sm:inline text-[10px] font-mono bg-muted text-muted-foreground px-1 py-0.5 rounded border border-border">
                  ⌘K
                </kbd>
              </button>
            )}
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

            {view.page !== "docs" && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setView({ page: "docs" })}
                title="API, MCP & CLI docs for agents"
              >
                <BookOpen className="h-3.5 w-3.5 mr-1" />
                Docs
              </Button>
            )}

            {/* Graph / Definitions / Board / Workflows used to live here as
                four separate buttons. They are views OF a nest, not global
                actions, so they moved to the nest view switcher below — which
                also keeps them reachable from each other. */}

            {adminStatus?.me ? (
              <UserMenu
                me={adminStatus.me}
                isAdmin={isAdmin}
                onApiKeys={() => setView({ page: "api-keys" })}
                onTeammates={() => setView({ page: "teammates" })}
                onTeams={() => setView({ page: "teams" })}
                onSettings={() => setView({ page: "settings" })}
                onGuide={() => setView({ page: "guide" })}
                onShortcuts={() => setShowShortcuts(true)}
                onTrace={() => setView({ page: "trace" })}
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
        </div>

        {/* Nest view switcher — one row for every view of the current nest.
            Rendered on all five nest-scoped pages (not just the nest page) so
            Board ⇄ Graph is one click instead of a trip back through the nest.
            Lives inside <header> so the whole block is one surface with a
            single bottom border, rather than two stacked bars.
            Nest context is read straight off the view: every page in
            NEST_VIEWS carries the same nestId/nestName/isOwner/isAnonOwned. */}
        {/* Reader mode leaves a lone "Nest" tab once the authoring views are
            filtered out — a one-tab strip is chrome, not navigation. readerMode
            already implies a read-only caller (deriveNestCaps), so the
            workflows tab can never join it. */}
        {isNestScoped(view) && !readerMode && (
           <div
           className={`${shellWidth} px-4 py-2 overflow-x-auto flex items-center gap-2${
             showSidebar ? " md:hidden" : ""
           }`}
         >
            <Tabs
              value={view.page}
              onValueChange={(page) =>
                setView({
                  page,
                  nestId: view.nestId,
                  nestName: view.nestName,
                  isOwner: view.isOwner,
                  isAnonOwned: view.isAnonOwned,
                  readerMode,
                  isArchived: view.isArchived,
                } as View)
              }
            >
              <TabsList>
                {NEST_VIEWS.filter((v) => {
                  // Each registry page carries its own gate (meta.visible).
                  const meta = nestPageForView(v.page);
                  return !meta?.visible || meta.visible({ isReadOnly: nestCanEdit === false, isReaderView: !!readerMode, canEditDocs: nestCanEdit === true, workflowPlaneEnabled });
                })
                  // Public Docs Reader Mode presents a clean, read-only docs
                  // view — the board, ontology graph and definitions authoring
                  // surfaces are hidden so a public reader sees only the docs.
                  .filter((v) => !readerMode || !isReaderHiddenView(v.page))
                  .map((v) => {
                  const Icon = v.icon;
                  return (
                    <TabsTrigger key={v.page} value={v.page} className="gap-1.5">
                      <Icon className="h-3.5 w-3.5" />
                      {v.label}
                      {v.beta && <BetaBadge />}
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            </Tabs>
          </div>
        )}
      </header>

      {/* Content */}
      {/* <main> owns page padding for every view — page roots must not add
          their own md:py-*, or one section sits lower than the next. */}
      {/* min-w-0 + clip: a page section that refuses to shrink (a nowrap row,
          a wide grid) must not widen the document. Page-level sideways scroll
          also drags fixed UI — toasts, dialogs — off the window, since their
          percentage boxes resolve against the wider block. `clip` (not
          `hidden`) keeps sticky headers inside pages working. */}
      <main
        className={`${shellWidth} min-w-0 overflow-x-clip${withSidebar ? "" : " px-4 py-4"}`}
      >
        {/* A ?nest link that didn't resolve. Falling through to the dashboard
            made a stale bookmark look like it had simply opened the app, with
            no way to tell "deleted" from "no access" from "bad link"
            (CU-wdqcpzzzrm) — but rendered as a bare full-screen view it read
            as a crash and took the navigation with it, so it sits inside the
            shell like any other page (CU-wdqcq01pe6). */}
        {deepLinkProbe.status === "unreachable" ? (
        <div className="py-20 text-center">
          <p className="text-lg font-medium">
            This nest doesn't exist or you don't have access.
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            It may have been deleted, the link may be out of date, or the
            request may simply have failed.
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            {/* A dropped request looks the same as a deleted nest from here,
                so offer the re-probe rather than making a network blip a
                permanent verdict. */}
            <Button
              variant="outline"
              onClick={() =>
                setDeepLinkProbe({
                  status: "loading",
                  nestId: deepLinkProbe.nestId,
                })
              }
            >
              Try again
            </Button>
            <Button onClick={() => setDeepLinkProbe({ status: "missing" })}>
              Back to dashboard
            </Button>
          </div>
        </div>
        ) : (
        <div className={withSidebar && !isDocPage ? "px-4 py-4" : ""}>
        {view.page === "dashboard" && (() => {
          const Page = dashboardPage(view.tab).Component;
          return (
            <AppNavProvider value={appNav}>
              <Suspense fallback={<div className="py-12 text-center text-muted-foreground">Loading...</div>}>
                <Page />
              </Suspense>
            </AppNavProvider>
          );
        })()}
        {view.page === "nest" && (
          <NestView
            nestId={view.nestId}
            nestName={view.nestName}
            isOwner={view.isOwner}
            isAnonOwned={view.isAnonOwned}
            isArchived={view.isArchived}
            initialSearch={view.initialSearch}
            initialTags={view.initialTags}
            initialFolder={view.initialFolder}
            initialTab={view.tab}
            initialDoc={view.readerDoc ?? null}
            onReaderDocChange={(nodeId) => setView({ ...view, readerDoc: nodeId ?? undefined })}
            onManageKeys={() => setView({ page: "api-keys" })}
            onTabChange={(tab) => setView({ ...view, tab })}
            onBack={leaveNest}
            onOpenDocument={(nodeId, opts) =>
              setView({
                page: "document",
                nestId: view.nestId,
                nestName: view.nestName,
                nodeId,
                isOwner: view.isOwner,
                isAnonOwned: view.isAnonOwned,
                initialFolder: opts?.folder,
                initialThreadId: opts?.thread,
              })
            }
            onOpenTrace={() =>
              setView({
                page: "nest-trace",
                nestId: view.nestId,
                nestName: view.nestName,
                isOwner: view.isOwner,
                isAnonOwned: view.isAnonOwned,
              })
            }
          />
        )}
        {view.page === "nest-trace" && (
          <ActivityTracePage
            nestId={view.nestId}
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
          const openNest = (opts?: {
            initialSearch?: string;
            initialTags?: string[];
            initialFolder?: string;
            tab?: string;
          }) =>
            setView({
              page: "nest",
              nestId: doc.nestId,
              nestName: doc.nestName,
              isOwner: doc.isOwner,
              isAnonOwned: doc.isAnonOwned,
              ...opts,
            });
          return (
            <DocumentEditor
              sidebarCollapsed={docSidebarCollapsed}
              onToggleSidebar={() => {
                // Phone: open the drawer. Desktop: bring the column back.
                if (window.matchMedia("(max-width: 767px)").matches)
                  setDocSidebarDrawer(true);
                else setDocSidebarCollapsed(false);
              }}
              // Key by nest + node so React unmounts the editor when the
              // user hops to a different doc (wiki-link nav) or pivots
              // from an existing doc into a fresh "new" page via a
              // broken-link click. Without this, useState values (title,
              // content, status) survive the prop change and the old
              // doc's body renders under the new doc's chrome — and
              // isNew flips true with stale state, hiding the status
              // badge + Submit-for-review button on the original doc.
              key={`${doc.nestId}/${doc.nodeId}/${(doc as any).initialFolder ?? ""}`}
              nestId={doc.nestId}
              nestName={doc.nestName}
              nodeId={doc.nodeId}
              initialFolder={(doc as any).initialFolder}
              initialThreadId={doc.initialThreadId}
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
                // Documents tab, not the nest's default Overview — every
                // caller of this is a "back to documents" affordance.
                openNest({ tab: "documents" });
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
                // Tag chip → nest list filtered by that tag (same tagFilters
                // mechanism the list rows use, not a text search).
                openNest({ initialTags: [tag] })
              }
              onOpenNest={() => openNest()}
              onOpenFolder={(folder) => openNest({ initialFolder: folder })}
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
        {/* Nest views from the registry (Board, Graph, Definitions, Workflows):
            one render for all, gated the same way the deep-link probe is. */}
        {isNestScoped(view) && view.page !== "nest" && (() => {
          const page = nestPageForView(view.page);
          if (!page || isViewBlockedInReaderMode(view.page, readerMode)) return null;
          const v = view;
          const ctx = {
            nestId: v.nestId,
            nestName: v.nestName,
            isOwner: v.isOwner,
            isAnonOwned: v.isAnonOwned,
            isArchived: v.isArchived,
            openDocument: (nodeId: string) =>
              setView({ page: "document", nestId: v.nestId, nestName: v.nestName, nodeId, isOwner: v.isOwner, isAnonOwned: v.isAnonOwned }),
            openNest: (opts?: { tags?: string[] }) =>
              setView({ page: "nest", nestId: v.nestId, nestName: v.nestName, isOwner: v.isOwner, isAnonOwned: v.isAnonOwned, ...(opts?.tags ? { initialTags: opts.tags } : {}) }),
            leaveNest,
          };
          return (
            <NestPageProvider value={ctx}>
              <Suspense fallback={<div className="py-12 text-center text-muted-foreground">Loading...</div>}>
                <page.Component />
              </Suspense>
            </NestPageProvider>
          );
        })()}
        {view.page === "api-keys" && (
          <ApiKeysPage onBack={() => setView({ page: "dashboard" })} />
        )}
        {view.page === "teammates" && (
          <TeammatesPage onBack={() => setView({ page: "dashboard" })} />
        )}
        {view.page === "teams" && (
          <TeamsPage onBack={() => setView({ page: "dashboard" })} />
        )}

        {view.page === "settings" && (
          <SettingsPage
            onBack={() => setView({ page: "dashboard" })}
            settings={serverSettings}
            onUpdate={updateServerSettings}
          />
        )}
        {view.page === "trace" && (
          <ActivityTracePage onBack={() => setView({ page: "dashboard" })} />
        )}
        {view.page === "docs" && (
          <AgentDocsPage onBack={() => setView({ page: "dashboard" })} />
        )}

        {view.page === "guide" && (
          <GuidePage onBack={() => setView({ page: "dashboard" })} />
        )}

        </div>
        )}
      </main>

      {/* Hidden on the document page: its editor ends in a sticky action bar,
          and anything rendered after <main> sits BELOW that bar's containing
          block — so the version line held Save and Discard off the bottom of
          the window at full scroll. The build version is a footnote; a write
          action reaching the edge of the screen is not. */}
      {view.page !== "document" && (
        <footer className={`${shellWidth} px-4 py-4 text-xs text-muted-foreground text-center`}>
          ContextNest Community{serverVersion ? ` v${serverVersion}` : ""}
        </footer>
      )}

      </div>
      {showConnect && "nestId" in view && (
        <ConnectModal
          isOpen
          onClose={() => setShowConnect(false)}
          nestId={view.nestId}
          nestName={view.nestName}
          onManageKeys={() => {
            setShowConnect(false);
            setView({ page: "api-keys" });
          }}
        />
      )}
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
  onApiKeys: () => void;
  onTeammates: () => void;
  onTeams: () => void;
  onSettings: () => void;
  onGuide: () => void;
  onShortcuts: () => void;
  onTrace: () => void;
  onChangePassword: () => void;
  onLogout: () => void;
}

function UserMenu({
  me,
  isAdmin,
  onApiKeys,
  onTeammates,
  onTeams,
  onSettings,
  onGuide,
  onShortcuts,
  onTrace,
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
            <DropdownMenuItem onSelect={onSettings} className="cursor-pointer">
              <Shield className="h-3.5 w-3.5 mr-2" />
              Server settings
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onTrace} className="cursor-pointer">
              <ScrollText className="h-3.5 w-3.5 mr-2" />
              Activity trace
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onApiKeys}
          className="cursor-pointer"
          data-testid="user-menu-api-keys"
        >
          <KeyRound className="h-3.5 w-3.5 mr-2" />
          API keys
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onTeams} className="cursor-pointer">
          <Users className="h-3.5 w-3.5 mr-2" />
          Teams
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onGuide} className="cursor-pointer">
          <BookOpen className="h-3.5 w-3.5 mr-2" />
          How it works
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onShortcuts} className="cursor-pointer">
          <Keyboard className="h-3.5 w-3.5 mr-2" />
          Keyboard shortcuts
        </DropdownMenuItem>
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
    if (next.trim().length === 0) {
      setError("New password cannot be empty or only whitespace.");
      return;
    }
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
