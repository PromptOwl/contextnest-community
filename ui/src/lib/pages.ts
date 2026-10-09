/**
 * App page registry (the top-level pages with the rail: Nests, My Work, Teammates, …) — built from the filesystem, so adding a page is
 * one folder and nothing else:
 *
 *   ui/src/pages/app/<slug>/meta.ts   — path, label, icon, order, badge, group, gate
 *   ui/src/pages/app/<slug>/page.tsx  — default export: the component
 *
 * `meta.ts` files load eagerly (they are tiny) so the sidebar can list every
 * page without loading any; `page.tsx` loads lazily, one chunk per page. The
 * folder name is the page id. Pages read navigation from `useAppNav()`, not
 * props, so App renders every page the same way.
 */
import type { ComponentType, LazyExoticComponent } from "react";
import { lazyChunk } from "./lazy-chunk";
import type { LucideIcon } from "lucide-react";

export interface PageBadge {
  /** react-query options for the count read (keep it a one-row read). */
  options: () => any;
  count: (data: any) => number;
  /** "primary" for things waiting on the user, "muted" for their own stuff. */
  tone?: "primary" | "muted";
}

/** Sidebar groups, in rail order. Ungrouped pages (Nests) sit above them. */
export const PAGE_GROUPS = [
  { id: "work", label: "Work" },
  { id: "workspace", label: "Workspace" },
  { id: "admin", label: "Admin" },
  { id: "help", label: "Help" },
] as const;
export type PageGroupId = (typeof PAGE_GROUPS)[number]["id"];

export interface PageCaps {
  isAdmin: boolean;
  /** MCP agent sign-in (OAuth) is on for this server. */
  mcpOauthEnabled?: boolean;
}

export interface PageMeta {
  /** URL path, e.g. "/my-work". Exactly one page owns "/". */
  path: string;
  label: string;
  icon: LucideIcon;
  /** Sidebar order, ascending. */
  order: number;
  badge?: PageBadge;
  /** Rail group; omitted = listed on its own above the groups. */
  group?: PageGroupId;
  /** Reachable by URL and the user menu, never a rail row. */
  hidden?: boolean;
  /** Who gets the page listed and reachable. Default: everyone signed in. */
  visible?: (caps: PageCaps) => boolean;
}

export interface AppPage extends PageMeta {
  id: string;
  Component: LazyExoticComponent<ComponentType>;
}

const metas = import.meta.glob<{ meta: PageMeta }>("../pages/app/*/meta.ts", {
  eager: true,
});
const loaders = import.meta.glob<{ default: ComponentType }>("../pages/app/*/page.tsx");

const idOf = (file: string) => file.split("/").slice(-2, -1)[0];

export const appPages: AppPage[] = Object.entries(metas)
  .map(([file, mod]) => {
    const id = idOf(file);
    const load = loaders[file.replace(/meta\.ts$/, "page.tsx")];
    if (!load) throw new Error(`pages/app/${id}: meta.ts has no page.tsx beside it`);
    return { id, ...mod.meta, Component: lazyChunk(load) };
  })
  .sort((a, b) => a.order - b.order);

export const DEFAULT_PAGE_ID = "nests";

export function appPage(id: string | undefined): AppPage {
  return (
    appPages.find((p) => p.id === id) ??
    appPages.find((p) => p.id === DEFAULT_PAGE_ID) ??
    appPages[0]
  );
}

export function appPath(id: string | undefined): string {
  return appPage(id).path;
}

/** The dashboard page a path opens, or null when it is not one. */
export function appPageIdFromPath(pathname: string): string | null {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return appPages.find((p) => p.path === clean)?.id ?? null;
}

export const isPageVisible = (page: PageMeta, caps: PageCaps): boolean =>
  !page.visible || page.visible(caps);

/** The page to actually show for `id`: a gated page the caller may not see
 *  (admin-only, reached by URL) resolves to the default page, so header,
 *  rail and body all agree. */
export function visibleAppPage(id: string | undefined, caps: PageCaps): AppPage {
  const page = appPage(id);
  return isPageVisible(page, caps) ? page : appPage(DEFAULT_PAGE_ID);
}

/** The rail's rows: ungrouped pages first, then each group that has a visible page. */
export function appRail(caps: PageCaps): {
  top: AppPage[];
  groups: Array<{ id: PageGroupId; label: string; pages: AppPage[] }>;
} {
  const visible = appPages.filter((p) => !p.hidden && isPageVisible(p, caps));
  return {
    top: visible.filter((p) => !p.group),
    groups: PAGE_GROUPS.map((g) => ({
      ...g,
      pages: visible.filter((p) => p.group === g.id),
    })).filter((g) => g.pages.length > 0),
  };
}
