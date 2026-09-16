import { BookMarked } from "lucide-react";
import type { NestPageMeta } from "../../../lib/nest-pages";

export const meta: NestPageMeta = {
  path: "definitions",
  label: "Definitions",
  icon: BookMarked,
  order: 3,
  viewPage: "definitions",
};
