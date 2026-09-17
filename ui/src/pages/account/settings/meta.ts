import { Shield } from "lucide-react";
import type { AccountPageMeta } from "../../../lib/account-pages";

export const meta: AccountPageMeta = {
  path: "/settings",
  label: "Server settings",
  icon: Shield,
  order: 11,
  viewPage: "settings",
  visible: ({ isAdmin }) => isAdmin,
};
