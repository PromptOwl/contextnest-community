import { Plug } from "lucide-react";
import type { PageMeta } from "../../../lib/pages";

export const meta: PageMeta = {
  path: "/connected-apps",
  label: "Connected apps",
  icon: Plug,
  order: 12,
  group: "workspace",
  // Only agents that signed in through MCP OAuth appear here.
  visible: ({ mcpOauthEnabled }) => !!mcpOauthEnabled,
};
