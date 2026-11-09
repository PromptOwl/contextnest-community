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
  /** Show one folder in the nest's Documents view. */
  openFolder: (folder: string) => void;
  /** Structure: the folder whose rule to open (?folder=). */
  folder?: string;
  /** Channels: the selected channel and the open thread (?channel=&thread=). */
  channel?: string;
  thread?: string;
  /** Channels: select a channel and/or open a thread; App writes the URL.
   *  `replace` keeps it off the Back stack (choosing the landing channel). */
  setChannelLocation?: (
    loc: { channel: string | null; thread?: string | null },
    opts?: { replace?: boolean },
  ) => void;
}

const Ctx = createContext<NestPageContext | null>(null);

export const NestPageProvider = Ctx.Provider;

export function useNestPage(): NestPageContext {
  const v = useContext(Ctx);
  if (!v) throw new Error("useNestPage: no NestPageProvider above this page");
  return v;
}
