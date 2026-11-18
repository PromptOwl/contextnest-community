import { PluginsPage as Plugins } from "../../../components/plugins/PluginsPage";
import { useNestPage } from "../../../lib/nest-page-context";

export default function PluginsPage() {
  const nest = useNestPage();
  return (
    <Plugins
      nestId={nest.nestId}
      nestName={nest.nestName}
      isArchived={nest.isArchived}
      onBack={nest.leaveNest}
      openDocument={nest.openDocument}
    />
  );
}
