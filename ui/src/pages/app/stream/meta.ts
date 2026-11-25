import { Rss } from "lucide-react";
import type { PageMeta } from "../../../lib/pages";

export const meta: PageMeta = {
  path: "/stream",
  label: "Stream",
  icon: Rss,
  order: 4,
  group: "work",
  // It lives in Chat as Updates (One chat 14); old links still open.
  hidden: true,
  // Experimental (EXPERIMENTAL_DOC_STREAM): listed only while the server has
  // it on, exactly when GET /me/stream answers instead of 404ing.
  visible: (caps) => !!caps.docStreamEnabled,
};
