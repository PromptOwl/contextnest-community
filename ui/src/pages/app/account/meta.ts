import { UserRound } from "lucide-react";
import type { PageMeta } from "../../../lib/pages";

export const meta: PageMeta = {
  path: "/account",
  label: "Account",
  icon: UserRound,
  order: 40,
  // Opened from the user menu (it is "me", not the app), so not a rail row.
  hidden: true,
};
