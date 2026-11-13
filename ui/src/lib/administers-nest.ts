/**
 * Does the signed-in person own or administer any nest? (po-1186 CR2: the
 * Control room is listed for them, showing the nests they administer.) Read
 * off the cached nest list the dashboard already loads; undefined until it
 * arrives, so callers choose how to treat "not known yet".
 */
import { useQuery } from "@tanstack/react-query";
import { reads } from "./queries";

export function administersAnyNest(nests: Array<{ permission?: string; is_owner?: boolean }> | undefined | null): boolean {
  return (nests ?? []).some((n) => n?.is_owner === true || n?.permission === "owner" || n?.permission === "admin");
}

export function useAdministersNest(enabled = true): boolean | undefined {
  const q = useQuery({ ...reads.nestList(), enabled });
  return q.data ? administersAnyNest((q.data as { nests?: Array<{ permission?: string; is_owner?: boolean }> }).nests) : undefined;
}
