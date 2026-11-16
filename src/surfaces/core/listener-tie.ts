/**
 * The ONE predicate for "this agent is the server-tied listener of this
 * binding" (security round 2 INFO: readers.ts and listener-service used to
 * check slightly different things). Pure: the callers pass the stored
 * config, the enabled flag and the binding id the row names.
 */
export function isTiedListenerConfig(config: unknown, enabled: boolean | number, bindingId: string): boolean {
  if (!config || typeof config !== "object") return false;
  const c = config as {
    surfaces_listener?: { binding_id?: unknown };
    feeds?: unknown[];
    mcp_servers?: unknown[];
    notify?: { recipients?: unknown[]; channels?: unknown[] };
  };
  return (
    !enabled &&
    typeof c.surfaces_listener?.binding_id === "string" &&
    c.surfaces_listener.binding_id === bindingId &&
    !(Array.isArray(c.feeds) && c.feeds.length) &&
    !(Array.isArray(c.mcp_servers) && c.mcp_servers.length) &&
    !(Array.isArray(c.notify?.recipients) && c.notify!.recipients!.length) &&
    !(Array.isArray(c.notify?.channels) && c.notify!.channels!.length)
  );
}
