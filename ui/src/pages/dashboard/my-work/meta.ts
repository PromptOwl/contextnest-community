import { Inbox } from "lucide-react";
import { reads } from "../../../lib/queries";
import type { PageMeta } from "../../../lib/pages";

export const meta: PageMeta = {
  path: "/my-work",
  label: "My Work",
  icon: Inbox,
  order: 2,
  width: "contained",
  // Things waiting on the user — the one-row read's total is the badge.
  badge: {
    options: () => reads.myWork({ limit: 1 }),
    count: (d) => d?.pagination?.total ?? 0,
    tone: "primary",
  },
};
