import { MaturityBoard } from "../../../components/MaturityBoard";
import { useNestPage } from "../../../lib/nest-page-context";

export default function BoardPage() {
  const nest = useNestPage();
  return (
    <MaturityBoard
      nestId={nest.nestId}
      nestName={nest.nestName}
      isOwner={nest.isOwner}
      isArchived={nest.isArchived}
      onBack={nest.leaveNest}
      onOpenDocument={nest.openDocument}
    />
  );
}
