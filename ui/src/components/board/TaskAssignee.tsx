/**
 * TaskAssignee — the Assignee row on a task's own page, the same picker the
 * board card uses. Like Relations, not document content: editable in view
 * mode, saved on pick. Only nest members are offered; sharing the nest with
 * someone new stays on the board.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import * as api from "../../lib/api";
import { AssigneeMenu, type Person } from "./CardParts";

export function TaskAssignee({
  nestId,
  nodeId,
  assignee,
  people,
  me,
  canEdit,
  onSaved,
}: {
  nestId: string;
  nodeId: string;
  assignee?: string;
  people: Person[];
  me?: string;
  canEdit: boolean;
  onSaved: (node: any) => void;
}) {
  const [value, setValue] = useState(assignee);
  useEffect(() => setValue(assignee), [assignee]);

  const save = async (email: string | null) => {
    const prev = value;
    setValue(email ?? undefined);
    try {
      const res: any = await api.updateNode(nestId, nodeId, { assignee: email });
      if (res?.node) onSaved(res.node);
    } catch (e: any) {
      setValue(prev);
      toast.error(e?.message || "Couldn't change the assignee");
    }
  };

  return (
    <section className="flex items-center gap-2" data-testid="task-assignee" aria-label="Assignee">
      <h3 className="text-xs font-medium text-muted-foreground">Assignee</h3>
      <AssigneeMenu
        assignee={value}
        people={people.filter((p) => p.member !== false)}
        me={me}
        editable={canEdit}
        onChange={(email) => void save(email)}
        showName
      />
    </section>
  );
}
