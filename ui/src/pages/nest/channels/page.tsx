import { ChannelsPage } from "../../../components/ChannelsPage";
import { useNestPage } from "../../../lib/nest-page-context";

export default function ChannelsNestPage() {
  const nest = useNestPage();
  return (
    <ChannelsPage
      nestId={nest.nestId}
      nestName={nest.nestName}
      isArchived={nest.isArchived}
      onBack={nest.leaveNest}
    />
  );
}
