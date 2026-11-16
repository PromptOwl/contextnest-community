import { Gauge } from "lucide-react";
import type { PageMeta } from "../../../lib/pages";

/**
 * Control room (po-1186): what agents are doing, how the nest fills up, and
 * the Slack setup. A top-level page, not a Settings tab. Server admins while
 * Surfaces is on; installing stays server-admin-only (the routes enforce it).
 */
export const meta: PageMeta = {
  path: "/control-room",
  label: "Control room",
  icon: Gauge,
  order: 13,
  group: "workspace",
  visible: ({ isAdmin, surfacesEnabled }) => isAdmin && !!surfacesEnabled,
};
