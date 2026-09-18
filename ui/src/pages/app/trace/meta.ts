import { ScrollText } from "lucide-react";
import type { PageMeta } from "../../../lib/pages";

export const meta: PageMeta = {
  path: "/trace",
  label: "Activity trace",
  icon: ScrollText,
  order: 22,
  group: "admin",
  visible: ({ isAdmin }) => isAdmin,
};
