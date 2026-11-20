import { ChatPage } from "../../../components/chat/ChatPage";
import { useNestPage } from "../../../lib/nest-page-context";

export default function ChatNestPage() {
  const nest = useNestPage();
  return (
    <ChatPage
      // One mount per nest: drafts and open dialogs belong to the nest they were started in.
      key={nest.nestId}
      nestId={nest.nestId}
      nestName={nest.nestName}
      onBack={nest.leaveNest}
      channel={nest.channel ?? null}
      thread={nest.thread ?? null}
      onLocation={(loc, opts) => nest.setChannelLocation?.(loc, opts)}
      onOpenNode={nest.openDocument}
      onOpenDocumentThread={nest.openDocumentThread}
    />
  );
}
