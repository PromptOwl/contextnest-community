/**
 * Activity trace (server-wide, admin). The component stays in components/
 * because the nest-scoped trace (nest-trace view) renders the same one with
 * a nestId; this is the rail entry.
 */
import { ActivityTracePage } from "../../../components/ActivityTracePage";

export default function TraceRoute() {
  return <ActivityTracePage />;
}
