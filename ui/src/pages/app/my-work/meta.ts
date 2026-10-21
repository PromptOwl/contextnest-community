import { Inbox } from "lucide-react";
import { reads } from "../../../lib/queries";
import { waitingOnMeCount } from "../../../lib/my-work-groups";
import type { PageMeta } from "../../../lib/pages";

export const meta: PageMeta = {
  path: "/my-work",
  label: "My Work",
  icon: Inbox,
  order: 2,
  group: "work",
  // Things waiting on the user — the one-row read's total plus the tasks
  // assigned to them is the badge.
  badge: {
    options: () => reads.myWork({ limit: 1 }),
    count: (d) => waitingOnMeCount(d),
    tone: "primary",
  },
};
