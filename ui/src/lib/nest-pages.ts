/**
 * Nest view registry — the pages that live beside a nest's own page
 * (/nest/<id>): Board, Graph, Definitions, Workflows. Same shape as the
 * app page registry (pages.ts): one folder per page,
 *
 *   ui/src/pages/nest/<slug>/meta.ts   — path segment, label, icon, order, gate
 *   ui/src/pages/nest/<slug>/page.tsx  — default export; reads useNestPage()
 *
 * and everything that lists nest views — the sidebar's Views group, the
 * header tab strip, the URL (/nest/<id>/<segment>), deep links, the
 * breadcrumb — derives from it. The nest page itself (Overview/Documents/…
 * tabs) is not a registry page: those tabs share one data load.
 *
 * `viewPage` ties a page to App's View union, which stays the navigation
 * state; a new page still needs its View member and a render branch is not
 * needed — App renders whichever registry page matches view.page.
 */
import type { ComponentType, LazyExoticComponent } from "react";
import { lazyChunk } from "./lazy-chunk";
import type { LucideIcon } from "lucide-react";

export interface NestPageCaps {
  isReadOnly: boolean;
  isReaderView: boolean;
  canEditDocs: boolean;
  workflowPlaneEnabled: boolean;
  /** Experimental channels (/health experimental.agent_stream, PO-1179). */
  agentStreamEnabled?: boolean;
}

export interface NestPageMeta {
  /** URL segment under /nest/<id>, e.g. "board" → /nest/<id>/board. */
  path: string;
  label: string;
  icon: LucideIcon;
  /** Sidebar / tab-strip order, ascending. */
  order: number;
  /** The App view this page renders as. */
  viewPage: "board" | "ontology-graph" | "definitions" | "workflows" | "structure" | "channels";
  beta?: boolean;
  /** Who gets the page listed and reachable. Reader mode hides every nest
   *  view regardless (see nest-caps isViewBlockedInReaderMode); this gate
   *  is for the rest — feature flags, write access. Default: everyone. */
  visible?: (caps: NestPageCaps) => boolean;
}

export interface NestPage extends NestPageMeta {
  id: string;
  Component: LazyExoticComponent<ComponentType>;
}

const metas = import.meta.glob<{ meta: NestPageMeta }>("../pages/nest/*/meta.ts", {
  eager: true,
});
const loaders = import.meta.glob<{ default: ComponentType }>("../pages/nest/*/page.tsx");

const idOf = (file: string) => file.split("/").slice(-2, -1)[0];

export const nestPages: NestPage[] = Object.entries(metas)
  .map(([file, mod]) => {
    const id = idOf(file);
    const load = loaders[file.replace(/meta\.ts$/, "page.tsx")];
    if (!load) throw new Error(`pages/nest/${id}: meta.ts has no page.tsx beside it`);
    return { id, ...mod.meta, Component: lazyChunk(load) };
  })
  .sort((a, b) => a.order - b.order);

export const nestPageForView = (viewPage: string): NestPage | undefined =>
  nestPages.find((p) => p.viewPage === viewPage);

export const nestPageForPath = (segment: string | null | undefined): NestPage | undefined =>
  segment ? nestPages.find((p) => p.path === segment) : undefined;

export const visibleNestPages = (caps: NestPageCaps): NestPage[] =>
  nestPages.filter((p) => !p.visible || p.visible(caps));
