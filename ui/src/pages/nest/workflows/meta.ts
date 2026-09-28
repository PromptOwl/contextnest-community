import { Workflow } from "lucide-react";
import type { NestPageMeta } from "../../../lib/nest-pages";

export const meta: NestPageMeta = {
  path: "workflows",
  label: "Workflows",
  icon: Workflow,
  order: 4,
  viewPage: "workflows",
  beta: true,
  // Behind the workflow-plane flag, and for people who can act in it.
  visible: (caps) => caps.workflowPlaneEnabled && caps.canEditDocs,
};
