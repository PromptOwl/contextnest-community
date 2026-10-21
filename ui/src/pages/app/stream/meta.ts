import { Rss } from "lucide-react";
import type { PageMeta } from "../../../lib/pages";

export const meta: PageMeta = {
  path: "/stream",
  label: "Stream",
  icon: Rss,
  order: 4,
  group: "work",
  // Experimental (EXPERIMENTAL_DOC_STREAM): listed only while the server has
  // it on, exactly when GET /me/stream answers instead of 404ing.
  visible: (caps) => !!caps.docStreamEnabled,
};
