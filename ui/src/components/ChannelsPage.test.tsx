import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMentions } from "./ChannelsPage";

// Channel posts come from agents and people alike: the body is text, never markup.
describe("channel message rendering (PO-1179)", () => {
  it("escapes markup in a post and highlights @mentions as text", () => {
    const html = renderToStaticMarkup(<p>{renderMentions('@stacey <img src=x onerror="alert(1)"> **bold**')}</p>);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain('<span class="font-medium text-primary">@stacey</span>');
    expect(html).toContain("**bold**");
  });

  it("leaves a lone @ and plain text alone", () => {
    expect(renderToStaticMarkup(<p>{renderMentions("a @ b")}</p>)).toBe("<p>a @ b</p>");
  });
});
