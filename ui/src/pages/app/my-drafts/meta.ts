import { Pencil } from "lucide-react";
import { reads } from "../../../lib/queries";
import type { PageMeta } from "../../../lib/pages";

export const meta: PageMeta = {
  path: "/my-drafts",
  label: "My Drafts",
  icon: Pencil,
  order: 3,
  group: "work",
  badge: {
    options: () => reads.myDrafts({ limit: 1 }),
    count: (d) => d?.pagination?.total ?? 0,
    tone: "muted",
  },
};
