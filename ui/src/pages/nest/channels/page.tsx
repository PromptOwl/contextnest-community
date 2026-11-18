import { ChannelsPage } from "../../../components/channels/ChannelsPage";
import { useNestPage } from "../../../lib/nest-page-context";

export default function ChannelsNestPage() {
  const nest = useNestPage();
  return (
    <ChannelsPage
      // One mount per nest: drafts and open dialogs belong to the nest they were started in.
      key={nest.nestId}
      nestId={nest.nestId}
      nestName={nest.nestName}
      onBack={nest.leaveNest}
      channel={nest.channel ?? null}
      thread={nest.thread ?? null}
      onLocation={(loc, opts) => nest.setChannelLocation?.(loc, opts)}
      onOpenNode={nest.openDocument}
    />
  );
}
