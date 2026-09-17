import { ScrollText } from "lucide-react";
import type { AccountPageMeta } from "../../../lib/account-pages";

export const meta: AccountPageMeta = {
  path: "/trace",
  label: "Activity trace",
  icon: ScrollText,
  order: 12,
  viewPage: "trace",
  visible: ({ isAdmin }) => isAdmin,
};
