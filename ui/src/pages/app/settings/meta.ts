import { Shield } from "lucide-react";
import type { PageMeta } from "../../../lib/pages";

export const meta: PageMeta = {
  path: "/settings",
  label: "Server settings",
  icon: Shield,
  order: 21,
  group: "admin",
  visible: ({ isAdmin }) => isAdmin,
};
