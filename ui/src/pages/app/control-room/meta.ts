import { Gauge } from "lucide-react";
import type { PageMeta } from "../../../lib/pages";

/**
 * Control room (po-1186): what agents are doing, how the nest fills up, and
 * the Slack setup. A top-level page, not a Settings tab, while Surfaces is on.
 * Superadmins only (Misha, 2026-11-18), replacing the 2026-11-09 owners/admins
 * rule (po-1186 decision 3): since first-run onboarding every user owns a
 * nest, so that rule showed it to everyone. Never in open mode, where everyone
 * is "admin". The page-only REST reads enforce the same (po-1406).
 */
export const meta: PageMeta = {
  path: "/control-room",
  label: "Control room",
  icon: Gauge,
  order: 13,
  // A top-level page, so it stays in the rail with the other work pages.
  group: "work",
  visible: ({ isSuperadmin, surfacesEnabled }) => !!surfacesEnabled && !!isSuperadmin,
};
