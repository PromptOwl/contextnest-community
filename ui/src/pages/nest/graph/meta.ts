import { Network } from "lucide-react";
import type { NestPageMeta } from "../../../lib/nest-pages";

export const meta: NestPageMeta = {
  path: "graph",
  label: "Graph",
  icon: Network,
  order: 2,
  viewPage: "ontology-graph",
};
