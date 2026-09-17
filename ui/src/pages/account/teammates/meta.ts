import { Users } from "lucide-react";
import type { AccountPageMeta } from "../../../lib/account-pages";

export const meta: AccountPageMeta = {
  path: "/teammates",
  label: "Teammates",
  icon: Users,
  order: 10,
  viewPage: "teammates",
  visible: ({ isAdmin }) => isAdmin,
};
