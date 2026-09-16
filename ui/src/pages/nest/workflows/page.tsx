import { WorkflowsView } from "../../../components/WorkflowsView";
import { useNestPage } from "../../../lib/nest-page-context";

export default function WorkflowsPage() {
  const nest = useNestPage();
  return <WorkflowsView nestId={nest.nestId} nestName={nest.nestName} onBack={nest.leaveNest} />;
}
