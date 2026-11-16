/** po-1213: the top of Documents — lede, summary line, "Recently edited" feed, empty nest. */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DocumentsHome, EmptyNest, LastEditText, type RecentItem } from "./DocumentsHome";

const people = [{ email: "priya@larkspur.example", name: "Priya Raman" }];
const now = new Date().toISOString();

const render = (recent: RecentItem[], extra: Partial<Parameters<typeof DocumentsHome>[0]> = {}) =>
  renderToStaticMarkup(
    <DocumentsHome
      description="Larkspur's account playbook."
      stats={{ total: 12 }}
      folderCount={3}
      editedThisWeek={4}
      recent={recent}
      people={people}
      onOpenDocument={() => {}}
      {...extra}
    />,
  );

describe("AC-NH-02: DocumentsHome", () => {
  it("Given a nest, then the lede and the summary line sit at the top", () => {
    const h = render([]);
    expect(h).toContain('data-testid="nest-home-description"');
    expect(h).toContain("Larkspur&#x27;s account playbook.");
    expect(h).toContain('data-testid="nest-home-facts"');
    expect(h).toMatch(/12 documents/);
  });

  it("Given no recent edits, then there is no feed", () => {
    expect(render([])).not.toContain('data-testid="nest-recent-feed"');
  });

  it("Given an agent's edit, then the feed item reads '<human> via <agent>' with the time and full date on hover", () => {
    const h = render([
      {
        id: "accounts/acme",
        title: "Acme",
        updated_at: now,
        last_edit: { edited_by: "priya@larkspur.example", edited_at: now, client: { agent: "deal-desk" } },
      },
    ]);
    expect(h).toContain('data-testid="recent-item-accounts/acme"');
    expect(h).toContain("Acme");
    expect(h).toContain("accounts");
    expect(h).toMatch(/data-testid="last-editor"[^>]*>Priya Raman via deal-desk</);
    expect(h).toMatch(/<time[^>]*dateTime="[^"]+"[^>]*title="[^"]+"/);
  });

  it("Given a reader who gets no last_edit (public), then the item shows the time and names nobody", () => {
    const h = render([{ id: "a", title: "A", updated_at: now }]);
    expect(h).toContain('data-testid="recent-item-a"');
    expect(h).not.toContain('data-testid="last-editor"');
    expect(h).toContain("<time");
  });

  it("Given a governed nest with pending items and a Review Queue, then the pending count is a link to it", () => {
    const h = render([], {
      governance: { pending: 2, approved: 5, reviewable: 2 },
      onOpenReview: () => {},
    });
    expect(h).toMatch(/<button[^>]*>.*pending/s);
  });
});

describe("AC-NH-03: LastEditText (rows, cards and the feed)", () => {
  it("Given an editor and a time, then editor · time", () => {
    const h = renderToStaticMarkup(<LastEditText edit={{ editor: "Priya Raman via deal-desk", at: now }} />);
    expect(h).toMatch(/Priya Raman via deal-desk<\/span><span aria-hidden="true">·<\/span><time/);
  });

  it("Given a time alone, then no separator dangles", () => {
    const h = renderToStaticMarkup(<LastEditText edit={{ editor: null, at: now }} />);
    expect(h).not.toContain("·");
    expect(h).toContain("<time");
  });
});

describe("AC-NH-05: an empty nest gets the start actions", () => {
  it("Given a writer, then New, Import and Add with AI", () => {
    const h = renderToStaticMarkup(
      <EmptyNest canWrite onNewDocument={() => {}} onImport={() => {}} onAddWithAI={() => {}} />,
    );
    expect(h).toContain("New document");
    expect(h).toContain("Import files");
    expect(h).toContain("Add with AI");
  });

  it("Given a reader with no actions, then a plain 'No documents yet'", () => {
    const h = renderToStaticMarkup(<EmptyNest canWrite={false} onNewDocument={() => {}} />);
    expect(h).toContain("No documents yet.");
    expect(h).not.toContain("New document");
  });
});
