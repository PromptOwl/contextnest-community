import { Users } from "lucide-react";
import type { PageMeta } from "../../../lib/pages";

export const meta: PageMeta = {
  path: "/teammates",
  label: "Teammates",
  icon: Users,
  order: 20,
  group: "settings",
  visible: ({ isAdmin }) => isAdmin,
};
