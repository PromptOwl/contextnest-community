/**
 * Where a link inside a message goes: the nest the channel is in, and how to
 * open one of its documents in the app. Provided once by the page so a
 * message deep in a thread does not need it handed down as props.
 */
import { createContext, useContext } from "react";

export interface ChannelNav {
  nestId: string;
  openNode: (nodeId: string) => void;
}

const Ctx = createContext<ChannelNav | null>(null);

export const ChannelNavProvider = Ctx.Provider;

/** Null outside the Channels page: links then load their address. */
export function useChannelNav(): ChannelNav | null {
  return useContext(Ctx);
}
