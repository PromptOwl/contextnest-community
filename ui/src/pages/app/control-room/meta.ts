import { Gauge } from "lucide-react";
import type { PageMeta } from "../../../lib/pages";

/**
 * Control room (po-1186): what agents are doing, how the nest fills up, and
 * the Slack setup. A top-level page, not a Settings tab, while Surfaces is on.
 * Server admins see every nest; nest owners and admins see the nests they
 * administer (decision 3, 2026-11-09; the ledger routes narrow themselves).
 * Installing stays server-admin-only (the routes enforce it; the page hides
 * the Setup tab from everyone else).
 */
export const meta: PageMeta = {
  path: "/control-room",
  label: "Control room",
  icon: Gauge,
  order: 13,
  group: "workspace",
  visible: ({ isAdmin, surfacesEnabled, administersNest }) => !!surfacesEnabled && (isAdmin || !!administersNest),
};
