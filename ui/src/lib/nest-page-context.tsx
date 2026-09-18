/**
 * What a nest view page gets from App: which nest it is in and how to move
 * on from it. Pages read it with useNestPage() instead of taking props, so
 * App renders every registry page the same way (see nest-pages.ts).
 */
import { createContext, useContext } from "react";

export interface NestPageContext {
  nestId: string;
  nestName: string;
  isOwner: boolean;
  isAnonOwned: boolean;
  isArchived?: boolean;
  /** Open a document of this nest. */
  openDocument: (nodeId: string) => void;
  /** Back to the nest page, optionally pre-scoped to tags. */
  openNest: (opts?: { tags?: string[] }) => void;
  /** Leave the nest entirely (the pages' back arrow). */
  leaveNest: () => void;
}

const Ctx = createContext<NestPageContext | null>(null);

export const NestPageProvider = Ctx.Provider;

export function useNestPage(): NestPageContext {
  const v = useContext(Ctx);
  if (!v) throw new Error("useNestPage: no NestPageProvider above this page");
  return v;
}
