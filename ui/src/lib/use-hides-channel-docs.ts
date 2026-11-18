import { useAuth } from "../auth/AuthContext";
import { useNestMeta } from "./queries";

/**
 * Are this nest's channel nodes kept out of its document surfaces for the
 * caller? The hook twin of `hidesChannelDocs` (queries.ts), for a component
 * that filters a listing it already holds: channels on, and the caller is a
 * person added to the nest.
 */
export function useHidesChannelDocs(nestId: string | undefined): boolean {
  const { agentStreamEnabled } = useAuth();
  const meta = useNestMeta(agentStreamEnabled ? nestId : undefined);
  return agentStreamEnabled && meta.data?.member === true;
}
