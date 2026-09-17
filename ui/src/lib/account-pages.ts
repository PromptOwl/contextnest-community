/**
 * Account page registry — the pages behind the user menu (Teammates, Server
 * settings, Activity trace, API keys, Teams, How it works, Account). Same
 * shape as the dashboard registry (pages.ts): one folder per page,
 *
 *   ui/src/pages/account/<slug>/meta.ts   — path, label, icon, order, gate, viewPage
 *   ui/src/pages/account/<slug>/page.tsx  — default export; reads useAppNav()
 *
 * and the user menu, the account sidebar, the URL and the breadcrumb all
 * derive from it. `viewPage` ties a page to App's View union, which stays the
 * navigation state (each page keeps its own View member and menu item).
 */
import type { ComponentType, LazyExoticComponent } from "react";
import { lazyChunk } from "./lazy-chunk";
import type { LucideIcon } from "lucide-react";

export type AccountViewPage =
  | "teammates"
  | "settings"
  | "trace"
  | "api-keys"
  | "teams"
  | "guide"
  | "account";

export interface AccountPageCaps {
  isAdmin: boolean;
}

export interface AccountPageMeta {
  /** URL path, e.g. "/teammates". */
  path: string;
  label: string;
  icon: LucideIcon;
  /** Sidebar order, ascending. Admin pages sit in the 10s, everyone's in the 20s. */
  order: number;
  /** The App view this page renders as. */
  viewPage: AccountViewPage;
  /** Who gets the page listed. Default: everyone signed in. */
  visible?: (caps: AccountPageCaps) => boolean;
}

export interface AccountPage extends AccountPageMeta {
  id: string;
  Component: LazyExoticComponent<ComponentType>;
}

const metas = import.meta.glob<{ meta: AccountPageMeta }>("../pages/account/*/meta.ts", {
  eager: true,
});
const loaders = import.meta.glob<{ default: ComponentType }>("../pages/account/*/page.tsx");

const idOf = (file: string) => file.split("/").slice(-2, -1)[0];

export const accountPages: AccountPage[] = Object.entries(metas)
  .map(([file, mod]) => {
    const id = idOf(file);
    const load = loaders[file.replace(/meta\.ts$/, "page.tsx")];
    if (!load) throw new Error(`pages/account/${id}: meta.ts has no page.tsx beside it`);
    return { id, ...mod.meta, Component: lazyChunk(load) };
  })
  .sort((a, b) => a.order - b.order);

export const accountPageForView = (viewPage: string): AccountPage | undefined =>
  accountPages.find((p) => p.viewPage === viewPage);

/** The account page a path opens, or undefined when it is not one. */
export const accountPageForPath = (pathname: string): AccountPage | undefined => {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return accountPages.find((p) => p.path === clean);
};

export const visibleAccountPages = (caps: AccountPageCaps): AccountPage[] =>
  accountPages.filter((p) => !p.visible || p.visible(caps));
