import { Plug } from "lucide-react";
import type { NestPageMeta } from "../../../lib/nest-pages";

export const meta: NestPageMeta = {
  path: "plugins",
  label: "Plugins",
  icon: Plug,
  order: 6,
  viewPage: "plugins",
  beta: true,
  // Behind the server's plugins flag (FEATURE_PLUGINS). Everyone who works in
  // the nest can see what is connected — owners/admins configure, editors
  // run, viewers read; a docs-site reader is never shown it.
  visible: (caps) => !!caps.pluginsEnabled && !caps.isReaderView,
};
