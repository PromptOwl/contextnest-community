import { OntologyGraphView } from "../../../components/OntologyGraphView";
import { useNestPage } from "../../../lib/nest-page-context";

export default function GraphPage() {
  const nest = useNestPage();
  return (
    <OntologyGraphView
      nestId={nest.nestId}
      nestName={nest.nestName}
      onOpenTag={(tag) => nest.openNest({ tags: [tag] })}
      onOpenDocument={nest.openDocument}
      onBack={nest.leaveNest}
    />
  );
}
