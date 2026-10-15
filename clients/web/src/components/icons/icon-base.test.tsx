// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindIconHover } from "./icon-base";

const pointer = (type: string, pointerType: string) => Object.assign(new Event(type), { pointerType });

function setup(html: string) {
  document.body.innerHTML = html;
  const icon = document.querySelector("svg")!;
  const start = vi.fn();
  const stop = vi.fn();
  const cleanup = bindIconHover(icon, start, stop);
  return { icon, start, stop, cleanup, host: icon.closest("button, a, [role]") as HTMLElement | null };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("bindIconHover", () => {
  it("starts on mouse enter of the parent button and stops on leave", () => {
    const { host, start, stop } = setup(`<button><svg></svg></button>`);
    host!.dispatchEvent(pointer("pointerenter", "mouse"));
    expect(start).toHaveBeenCalledTimes(1);
    host!.dispatchEvent(pointer("pointerleave", "mouse"));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("works for links, menu items and tabs", () => {
    for (const html of [`<a href="/x"><svg></svg></a>`, `<div role="menuitem"><svg></svg></div>`, `<div role="tab"><svg></svg></div>`]) {
      const { host, start } = setup(html);
      host!.dispatchEvent(pointer("pointerenter", "pen"));
      expect(start).toHaveBeenCalledTimes(1);
    }
  });

  it("ignores touch pointers", () => {
    const { host, start } = setup(`<button><svg></svg></button>`);
    host!.dispatchEvent(pointer("pointerenter", "touch"));
    expect(start).not.toHaveBeenCalled();
  });

  it("starts on keyboard focus (focus-visible) and stops on blur", () => {
    const { host, start, stop } = setup(`<button><svg></svg></button>`);
    host!.matches = ((sel: string) => sel === ":focus-visible") as HTMLElement["matches"];
    host!.dispatchEvent(new FocusEvent("focusin"));
    expect(start).toHaveBeenCalledTimes(1);
    host!.dispatchEvent(new FocusEvent("focusout"));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("focus without focus-visible does nothing", () => {
    const { host, start } = setup(`<button><svg></svg></button>`);
    host!.matches = (() => false) as HTMLElement["matches"];
    host!.dispatchEvent(new FocusEvent("focusin"));
    expect(start).not.toHaveBeenCalled();
  });

  it("no interactive ancestor → no-op", () => {
    const { icon, start } = setup(`<h2><svg></svg></h2>`);
    icon.parentElement!.dispatchEvent(pointer("pointerenter", "mouse"));
    expect(start).not.toHaveBeenCalled();
  });

  it("cleanup removes the listeners", () => {
    const { host, start, cleanup } = setup(`<button><svg></svg></button>`);
    cleanup();
    host!.dispatchEvent(pointer("pointerenter", "mouse"));
    expect(start).not.toHaveBeenCalled();
  });
});
