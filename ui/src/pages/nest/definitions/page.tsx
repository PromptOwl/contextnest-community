import { DefinitionsPage as Definitions } from "../../../components/DefinitionsPage";
import { useNestPage } from "../../../lib/nest-page-context";

export default function DefinitionsPage() {
  const nest = useNestPage();
  return (
    <Definitions
      nestId={nest.nestId}
      nestName={nest.nestName}
      isArchived={nest.isArchived}
      onBack={nest.leaveNest}
    />
  );
}
