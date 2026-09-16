import { LayoutGrid } from "lucide-react";
import type { NestPageMeta } from "../../../lib/nest-pages";

export const meta: NestPageMeta = {
  path: "board",
  label: "Board",
  icon: LayoutGrid,
  order: 1,
  viewPage: "board",
};
