import { Mail } from "lucide-react";
import type { PageMeta } from "../../../lib/pages";

export const meta: PageMeta = {
  path: "/messages",
  label: "Message log",
  icon: Mail,
  order: 23,
  group: "admin",
  // Superadmin only — never open mode. The server enforces the same rule.
  visible: ({ isSuperadmin }) => !!isSuperadmin,
};
