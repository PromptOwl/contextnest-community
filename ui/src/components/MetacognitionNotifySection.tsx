/**
 * "Who can it notify?" — the metacognition form's notify settings
 * (CU-wdqcq05rkq). The owner picks the people; the agent can only choose
 * among them, never type an address of its own. The server checks each one
 * is on the nest when saved, and again every time the agent sends.
 */
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { listConnectors, listMentionablePeople, type Connector, type MetacognitionNotifyConfig } from "../lib/api";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export interface NotifyDraft {
  recipients: string[];
  email: boolean;
  connectors: boolean;
  max_per_run: number;
}

export const EMPTY_NOTIFY: NotifyDraft = { recipients: [], email: true, connectors: false, max_per_run: 3 };

export function toNotifyDraft(n: MetacognitionNotifyConfig | undefined): NotifyDraft {
  if (!n || !n.recipients.length) return EMPTY_NOTIFY;
  return {
    recipients: n.recipients,
    email: n.channels.includes("email"),
    connectors: n.channels.includes("connectors"),
    max_per_run: n.max_per_run,
  };
}

/** Nobody chosen = notify off (channels are then irrelevant). */
export function toNotifyConfig(d: NotifyDraft): MetacognitionNotifyConfig {
  if (!d.recipients.length) return { recipients: [], channels: [], max_per_run: d.max_per_run };
  return {
    recipients: d.recipients,
    channels: [...(d.email ? (["email"] as const) : []), ...(d.connectors ? (["connectors"] as const) : [])],
    max_per_run: d.max_per_run,
  };
}

const ROLE_LABEL: Record<string, string> = { owner: "The nest owner", reviewers: "Reviewers" };

export function MetacognitionNotifySection({
  nestId,
  value,
  onChange,
}: {
  nestId: string;
  value: NotifyDraft;
  onChange: (next: NotifyDraft) => void;
}) {
  const [people, setPeople] = useState<Array<{ email: string; name: string | null }>>([]);
  const [channels, setChannels] = useState<Connector[] | null>(null);
  const [pick, setPick] = useState("");

  useEffect(() => {
    let live = true;
    listMentionablePeople(nestId)
      .then((r) =>
        live &&
        setPeople(
          // Members only (not directory suggestions), and never a service identity.
          r.people.filter((p) => p.member !== false && !/\.invalid$/i.test(p.email)),
        ),
      )
      .catch(() => live && setPeople([]));
    listConnectors(nestId)
      .then((c) => live && setChannels(c.filter((x) => x.enabled && (x.events.includes("*") || x.events.includes("agent_notify")))))
      .catch(() => live && setChannels([]));
    return () => {
      live = false;
    };
  }, [nestId]);

  const has = (key: string) => value.recipients.includes(key);
  const toggle = (key: string, on: boolean) =>
    onChange({ ...value, recipients: on ? [...value.recipients.filter((r) => r !== key), key] : value.recipients.filter((r) => r !== key) });
  const nameOf = (email: string) => people.find((p) => p.email.toLowerCase() === email)?.name;
  const chosenPeople = value.recipients.filter((r) => !ROLE_LABEL[r]);
  const addable = people.filter((p) => !has(p.email.toLowerCase()));
  const off = value.recipients.length === 0;
  const noChannel = !off && !value.email && !value.connectors;

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="metacognition-notify">
      <div>
        <Label>Who can it notify?</Label>
        <p className="text-[11px] text-muted-foreground">
          The agent can send a short note to the people you pick here, and nobody else. It can't add anyone by name or
          address. Leave everyone unticked to keep notifications off.
        </p>
      </div>

      <div className="flex flex-wrap gap-4">
        {Object.entries(ROLE_LABEL).map(([key, label]) => (
          <label key={key} className="flex items-center gap-2 text-sm">
            <Checkbox checked={has(key)} onCheckedChange={(v) => toggle(key, v === true)} data-testid={`metacognition-notify-${key}`} />
            {label}
          </label>
        ))}
      </div>

      <div className="space-y-1">
        <div className="flex flex-wrap gap-1.5">
          {chosenPeople.map((email) => (
            <span key={email} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
              {nameOf(email) ? `${nameOf(email)} (${email})` : email}
              <button type="button" title="Remove" onClick={() => toggle(email, false)} className="text-muted-foreground hover:text-foreground">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
        <select
          value={pick}
          onChange={(e) => {
            if (e.target.value) toggle(e.target.value, true);
            setPick("");
          }}
          className="h-8 w-full sm:w-80 rounded-md border bg-background px-2 text-sm"
          data-testid="metacognition-notify-person"
        >
          <option value="">{addable.length ? "Add a person from this nest…" : "Everyone on this nest is already added"}</option>
          {addable.map((p) => (
            <option key={p.email} value={p.email.toLowerCase()}>
              {p.name ? `${p.name} (${p.email})` : p.email}
            </option>
          ))}
        </select>
      </div>

      {!off && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>How to reach them</Label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={value.email} onCheckedChange={(v) => onChange({ ...value, email: v === true })} />
              Email
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={value.connectors} onCheckedChange={(v) => onChange({ ...value, connectors: v === true })} />
              This nest's Slack / Teams channels
            </label>
            {value.connectors && channels !== null && (
              <p className="text-[11px] text-muted-foreground">
                {channels.length
                  ? `Posts to ${channels.map((c) => (c.channel === "teams" ? "Teams" : c.channel === "slack" ? "Slack" : "a webhook")).join(", ")}.`
                  : "No channel of this nest listens for agent notifications yet. An admin can add a connector with the agent_notify event."}
              </p>
            )}
            {noChannel && <p className="text-[11px] text-destructive">Pick at least one way to reach them.</p>}
          </div>
          <div className="space-y-1">
            <Label>Most notifications per run</Label>
            <Input
              type="number"
              min={1}
              max={10}
              value={value.max_per_run}
              onChange={(e) => onChange({ ...value, max_per_run: Number(e.target.value) || 1 })}
              className="w-24"
            />
            <p className="text-[11px] text-muted-foreground">Up to 10. Each one is a message in someone's inbox or channel.</p>
          </div>
        </div>
      )}
    </div>
  );
}
