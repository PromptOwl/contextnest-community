/**
 * Activity trace (server-wide, admin). The component stays in components/
 * because the nest-scoped trace (nest-trace view) renders the same one with
 * a nestId; this is the user-menu entry.
 */
import { ActivityTracePage } from "../../../components/ActivityTracePage";
import { useAppNav } from "../../../lib/app-nav";

export default function TraceRoute() {
  const { openDashboard } = useAppNav();
  return <ActivityTracePage onBack={openDashboard} />;
}
