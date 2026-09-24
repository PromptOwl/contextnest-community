import type React from "react";
import {
  BookOpen,
  Boxes,
  FileText,
  KeyRound,
  ShieldCheck,
  LayoutGrid,
  Users,
  Settings,
  UserCircle,
  UserPlus,
} from "lucide-react";
import { BetaBadge } from "@/components/ui/beta-badge";
import { PageTitle } from "@/components/ui/page-title";
import { useAppNav } from "@/lib/app-nav";
import { ADMIN_HELP_TOPICS } from "./help-topics";

/**
 * How it works — a tour of the app in the order the sidebar shows it: what a
 * nest is, what you can do with a document, how review works, and what each
 * page in the rail is for. Text only so it loads instantly. Agent-facing
 * detail (endpoints, MCP tools, CLI) lives on the Docs page.
 */

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon?: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        {Icon && (
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Icon className="h-4 w-4" />
          </span>
        )}
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      </div>
      {children}
    </section>
  );
}

/** Numbered steps with a connecting rail — reads as a sequence, not a list. */
function Steps({ steps }: { steps: React.ReactNode[] }) {
  return (
    <ol className="space-y-3">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-3">
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            {i + 1}
          </span>
          <span className="text-muted-foreground pt-0.5">{s}</span>
        </li>
      ))}
    </ol>
  );
}

/** A term/definition rendered as a card. */
function DefCard({ term, def }: { term: string; def: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-3 transition-colors hover:border-primary/40">
      <div className="mb-1 text-sm font-semibold">{term}</div>
      <div className="text-xs leading-relaxed text-muted-foreground">{def}</div>
    </div>
  );
}

/** "Thing — what it does" rows; the workhorse of this page. */
function Bullets({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <ul className="space-y-2">
      {items.map(([term, def]) => (
        <li key={term} className="text-muted-foreground">
          <b className="text-foreground">{term}</b> — {def}
        </li>
      ))}
    </ul>
  );
}

const Kbd = ({ children }: { children: React.ReactNode }) => (
  <kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs">{children}</kbd>
);

const GOVERNANCE: [string, string][] = [
  ["Just me", "Stewardship off. Saving publishes at once. Right for a personal nest."],
  ["Me, with a paper trail", "Stewardship on, self-approve allowed. Every change waits for review and you approve your own — a history without ceremony."],
  ["A team", "Stewards (viewer / editor / reviewer) per nest, tag or document. You cannot approve your own change; agents queue like everyone else."],
  ["Prime documents", "Mark a document or tag as prime and it always needs a second person, even where self-approve is on."],
];

export default function GuidePage() {
  const { manageKeys } = useAppNav();
  return (
    <div className="w-full">
      <PageTitle
        icon={BookOpen}
        title="How it works"
        description="A tour of the app, page by page. Agent setup (API, MCP, CLI) is on the Docs page in the header."
        className="mb-10"
      />

      <div className="space-y-10 text-sm leading-relaxed">
        <Section title="What this is">
          <div className="rounded-lg border-l-2 border-primary bg-muted/40 p-4">
            <p className="text-muted-foreground">
              A shared knowledge base for your team <i>and</i> your AI agents. Documents live in{" "}
              <b className="text-foreground">nests</b>. Every save is a version you can go back to. In a
              stewarded nest a change waits for a reviewer before agents can read it. People write here;
              agents read and write the same documents over the API, MCP or the <code className="rounded bg-muted px-1 py-0.5 text-xs">ctx</code> CLI.
            </p>
          </div>
        </Section>

        <Section title="Nests" icon={Boxes}>
          <Bullets
            items={[
              ["Create", <>From the Nests page — server admins only, unless an admin lets everyone create nests in Server settings. Have Markdown already? <b>Import folder</b> brings a whole directory in.</>],
              ["Organize", <>Folders and subfolders in the sidebar; move a document from its folder picker. With many nests, the sidebar has a name filter.</>],
              ["Share", <>The whole nest with a person or a team (viewer / editor / admin), or just one document or folder — the recipient sees only that slice.</>],
              ["Go public", <>A public nest gets a read-only <b>Reader mode</b> with a home document. A single document can also be published to a link.</>],
              ["Housekeeping", <>Rename, pin, archive or delete a nest. Anyone can request a deletion; an owner honours or declines it.</>],
            ]}
          />
        </Section>

        <Section title="Inviting someone" icon={UserPlus}>
          <Steps
            steps={[
              <><b>Share a nest</b> with their email (the nest's Collaborators tab), or add them under <b>Teammates</b> and pick a nest to share right there. Joining the server alone gives no nest access.</>,
              <>They get an <b>invite email</b> naming the nest and who shared it. Adding a teammate also emails a temporary password.</>,
              <>The link opens sign-in with their email filled in. They <b>Continue with PromptOwl</b> using that same email — creating a PromptOwl account there if they have none — or use the temporary password.</>,
              <>Signed in, they see <b>Pending invites</b> on the Nests page. <b>Accept</b> opens the nest; <b>Decline</b> removes their access.</>,
            ]}
          />
        </Section>

        <Section title="Documents" icon={FileText}>
          <Bullets
            items={[
              ["Types", <>Document (Markdown), Artifact (hosted HTML) and Table (CSV facts an agent can query row by row).</>],
              ["Writing", <>Rich editor or raw Markdown. <code className="rounded bg-muted px-1 py-0.5 text-xs">[[Title]]</code> links another document, <code className="rounded bg-muted px-1 py-0.5 text-xs">@name</code> mentions a person, <code className="rounded bg-muted px-1 py-0.5 text-xs">#</code> starts a heading.</>],
              ["Tags", <>Add them under the title. They stay local until you save.</>],
              ["Versions", <>Every save is a version. Compare with an earlier one or revert to it from the history menu.</>],
              ["Comments", <>Switch to <b>Comment</b> mode, select text, start a thread. Resolve or reopen it when done.</>],
              ["People", <>Who created it and who else has edited it sit under the title; mention someone with <code className="rounded bg-muted px-1 py-0.5 text-xs">@</code> to pull them in.</>],
              ["Find anything", <><Kbd>Ctrl</Kbd> / <Kbd>⌘</Kbd> <Kbd>K</Kbd> searches every nest and document. <Kbd>?</Kbd> lists all shortcuts.</>],
            ]}
          />
        </Section>

        <Section title="Review" icon={ShieldCheck}>
          <Steps
            steps={[
              <>Write and save. With stewardship off that is it — the document is published. With it on, the save is a <b>draft</b>.</>,
              <><b>Submit for review</b>. Stewards are notified; you can withdraw until someone acts.</>,
              <>A reviewer <b>approves</b> (published, visible to agents) or <b>rejects</b> with a note (back to draft).</>,
            ]}
          />
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {GOVERNANCE.map(([term, def]) => (
              <DefCard key={term} term={term} def={def} />
            ))}
          </div>
          <p className="mt-3 text-muted-foreground">
            <b className="text-foreground">My Work</b> is everything waiting on you across all nests.{" "}
            <b className="text-foreground">My Drafts</b> is what you wrote and never submitted.
          </p>
        </Section>

        <Section title="Views inside a nest" icon={LayoutGrid}>
          <Bullets
            items={[
              ["Board", <>Documents as cards in columns — by folder, by status, or by a tag family like <code className="rounded bg-muted px-1 py-0.5 text-xs">stage:*</code>. Drag to move or re-tag.</>],
              ["Graph", <>Documents, links, tags and stewards drawn as a graph.</>],
              ["Definitions", <>The nest's glossary — terms stewards define so people and agents mean the same thing.</>],
              ["Workflows", <><BetaBadge /> Agents are documents whose body is instructions. Wire one to a target document, run it by button, schedule or incoming hook; its output arrives as a pending review. Details on the Docs page.</>],
            ]}
          />
        </Section>

        <Section title="Workspace" icon={Users}>
          <Bullets
            items={[
              ["Teams", <>Group people once, then share nests with the team. Signed in with PromptOwl? Its teams can be synced in.</>],
              ["API keys", <>What agents, the CLI and MCP clients use to sign in. A key sees every nest you can, or just one.{" "}
                <button type="button" onClick={manageKeys} className="underline underline-offset-2 text-foreground">Manage keys</button>.</>],
              ["Connect", <>Bottom of the nest sidebar: the MCP URL and REST snippets for that nest. <b>Add with AI</b> on the nest overview is a prompt that has an agent write context in.</>],
            ]}
          />
        </Section>

        <Section title="Admin" icon={Settings}>
          <Bullets
            items={[
              ["Teammates", <>Invite people, reset passwords, remove accounts, name other admins.</>],
              ["Server settings", <>Public URL and logo, single sign-on, who can create nests, the Anthropic key, Slack / Teams / email notifications (email over SMTP or AWS SES), allowed content types, upload limit, telemetry.</>],
              ["Activity trace", <>Every governance action on the server. Each nest has its own trace under Activity.</>],
            ]}
          />
        </Section>

        {ADMIN_HELP_TOPICS.map((t) => (
          <Section key={t.id} title={t.title} icon={KeyRound}>
            <div id={`help-${t.id}`} className="space-y-3">
              <p className="text-muted-foreground">
                <span className="text-xs uppercase tracking-wide">For server admins</span>{" "}
                · <b className="text-foreground">{t.where}</b>
              </p>
              <p className="text-muted-foreground">{t.summary}</p>
              <Steps steps={t.steps} />
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                {t.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          </Section>
        ))}

        <Section title="Account" icon={UserCircle}>
          <p className="text-muted-foreground">
            Your name and password, from the menu in the top-right corner.
          </p>
        </Section>
      </div>
    </div>
  );
}
