import { Hash } from "lucide-react";
import type { NestPageMeta } from "../../../lib/nest-pages";

export const meta: NestPageMeta = {
  path: "channels",
  label: "Channels",
  icon: Hash,
  order: 6,
  viewPage: "channels",
  beta: true,
  // Experimental (EXPERIMENTAL_AGENT_STREAM, PO-1179): listed only while the
  // server has channels on. Readers see channels too; posting is write-tier.
  visible: (caps) => !!caps.agentStreamEnabled,
};
