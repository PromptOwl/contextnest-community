/** po-1213: a Documents list row renders one set of actions, so one pin control. */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ListRowActions } from "./ListRowActions";

const render = (phone: boolean) =>
  renderToStaticMarkup(
    <ListRowActions
      phone={phone}
      menu={<button type="button" data-testid="document-pin-control" title="Actions" />}
      inline={<button type="button" data-testid="document-pin-control" title="History" />}
    />,
  );

const pins = (html: string) => html.split('data-testid="document-pin-control"').length - 1;

describe("ListRowActions", () => {
  it("Given a desktop-width row, then only the hover buttons render: one pin control, no ⋮ menu", () => {
    const h = render(false);
    expect(pins(h)).toBe(1);
    expect(h).toContain('title="History"');
    expect(h).not.toContain('title="Actions"');
  });

  it("Given a phone-width row, then only the ⋮ menu renders: one pin control, no hover buttons", () => {
    const h = render(true);
    expect(pins(h)).toBe(1);
    expect(h).toContain('title="Actions"');
    expect(h).not.toContain('title="History"');
  });
});
