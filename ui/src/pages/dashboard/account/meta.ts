import { UserRound } from "lucide-react";
import type { PageMeta } from "../../../lib/pages";

export const meta: PageMeta = {
  path: "/account",
  label: "Account",
  icon: UserRound,
  order: 99,
  // Opened from the account menu, not the sidebar.
  hidden: true,
};
