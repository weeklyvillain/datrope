import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { Crash, NoAccess, NotFound, retryDelay } from "./errors";

// The in-shell frame pulls in the live session; these tests render the full-page frame only.
vi.mock("../app/EmptyView", () => ({ EmptyView: () => null }));

const render = (el: JSX.Element) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>);

describe("error pages", () => {
  it("not found offers a way home", () => {
    const html = render(<NotFound />);
    expect(html).toContain('role="heading" aria-level="1"');
    expect(html).toContain("Nothing here");
    expect(html).toContain('href="/"');
  });

  it("no access says why and offers a way home", () => {
    const html = render(<NoAccess />);
    expect(html).toContain("You can&#x27;t open this");
    expect(html).toContain("Go home");
  });

  it("a crash offers only a reload", () => {
    const html = renderToStaticMarkup(<Crash />);
    expect(html).toContain("Something broke");
    expect(html).toContain(">Reload</button>");
    expect(html).not.toContain("<a ");
  });
});

describe("retryDelay", () => {
  it("backs off to a minute", () => {
    expect([0, 1, 2, 3, 4, 9].map(retryDelay)).toEqual([5, 10, 20, 40, 60, 60]);
  });
});
