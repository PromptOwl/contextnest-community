/**
 * Dashboard page registry — built from the filesystem, so adding a page is
 * one folder and nothing else:
 *
 *   ui/src/pages/dashboard/<slug>/meta.ts   — path, label, icon, order, badge
 *   ui/src/pages/dashboard/<slug>/page.tsx  — default export: the component
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

export interface PageMeta {
  /** URL path, e.g. "/my-work". Exactly one page owns "/". */
  path: string;
  label: string;
  icon: LucideIcon;
  /** Sidebar order, ascending. */
  order: number;
  badge?: PageBadge;
}

export interface DashboardPage extends PageMeta {
  id: string;
  Component: LazyExoticComponent<ComponentType>;
}

const metas = import.meta.glob<{ meta: PageMeta }>("../pages/dashboard/*/meta.ts", {
  eager: true,
});
const loaders = import.meta.glob<{ default: ComponentType }>("../pages/dashboard/*/page.tsx");

const idOf = (file: string) => file.split("/").slice(-2, -1)[0];

export const dashboardPages: DashboardPage[] = Object.entries(metas)
  .map(([file, mod]) => {
    const id = idOf(file);
    const load = loaders[file.replace(/meta\.ts$/, "page.tsx")];
    if (!load) throw new Error(`pages/dashboard/${id}: meta.ts has no page.tsx beside it`);
    return { id, ...mod.meta, Component: lazyChunk(load) };
  })
  .sort((a, b) => a.order - b.order);

export const DEFAULT_PAGE_ID = "nests";

export function dashboardPage(id: string | undefined): DashboardPage {
  return (
    dashboardPages.find((p) => p.id === id) ??
    dashboardPages.find((p) => p.id === DEFAULT_PAGE_ID) ??
    dashboardPages[0]
  );
}

export function dashboardPath(id: string | undefined): string {
  return dashboardPage(id).path;
}

/** The dashboard page a path opens, or null when it is not one. */
export function dashboardPageIdFromPath(pathname: string): string | null {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return dashboardPages.find((p) => p.path === clean)?.id ?? null;
}
