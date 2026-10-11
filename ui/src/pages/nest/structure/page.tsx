import { StructurePage as Structure } from "../../../components/structure/StructurePage";
import { useNestPage } from "../../../lib/nest-page-context";

export default function StructurePage() {
  const nest = useNestPage();
  return (
    <Structure
      nestId={nest.nestId}
      nestName={nest.nestName}
      isArchived={nest.isArchived}
      onBack={nest.leaveNest}
      openDocument={nest.openDocument}
      initialFolder={nest.folder}
    />
  );
}
