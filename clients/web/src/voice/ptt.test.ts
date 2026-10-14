import { describe, expect, it } from "vitest";
import { bindUiPtt, combinePtt, setPttFromUi, watchPtt } from "./ptt";

const key = (type: string, code: string, repeat = false) => Object.assign(new Event(type), { code, repeat });

function setup(target: EventTarget = new EventTarget()) {
  const changes: boolean[] = [];
  const stop = watchPtt(target, () => "Backquote", (d) => changes.push(d));
  return { target, changes, stop };
}

/** Stands in for a focused element: events dispatched on it have it as their target. */
class FakeElement extends EventTarget {
  constructor(public tagName: string, public type = "", public isContentEditable = false) {
    super();
  }
}

describe("push to talk", () => {
  it("goes down and up with the key, once", () => {
    const { target, changes } = setup();
    target.dispatchEvent(key("keydown", "Backquote"));
    target.dispatchEvent(key("keydown", "Backquote", true));
    target.dispatchEvent(key("keydown", "KeyA"));
    target.dispatchEvent(key("keyup", "Backquote"));
    expect(changes).toEqual([true, false]);
  });

  it("ignores keys typed into text fields", () => {
    for (const el of [new FakeElement("INPUT", "text"), new FakeElement("TEXTAREA"), new FakeElement("DIV", "", true)]) {
      const { target, changes } = setup(el);
      target.dispatchEvent(key("keydown", "Backquote"));
      target.dispatchEvent(key("keyup", "Backquote"));
      expect(changes).toEqual([]);
    }
  });

  it("does not treat checkboxes as typing", () => {
    const { target, changes } = setup(new FakeElement("INPUT", "checkbox"));
    target.dispatchEvent(key("keydown", "Backquote"));
    expect(changes).toEqual([true]);
  });

  it("blur releases", () => {
    const { target, changes } = setup();
    target.dispatchEvent(key("keydown", "Backquote"));
    target.dispatchEvent(new Event("blur"));
    target.dispatchEvent(key("keyup", "Backquote"));
    expect(changes).toEqual([true, false]);
  });

  it("stops listening", () => {
    const { target, changes, stop } = setup();
    stop();
    target.dispatchEvent(key("keydown", "Backquote"));
    expect(changes).toEqual([]);
  });
});

describe("combinePtt", () => {
  it("is down while either source holds the key, and reports changes only", () => {
    const seen: boolean[] = [];
    const p = combinePtt((d) => seen.push(d));
    p.set("local", true);
    p.set("global", true);
    p.set("local", false);
    p.set("global", false);
    p.set("global", false);
    expect(seen).toEqual([true, false]);
  });
});

describe("hold to talk from the UI", () => {
  it("feeds the bound call's push to talk, and nothing once unbound", () => {
    const seen: boolean[] = [];
    const p = combinePtt((d) => seen.push(d));
    bindUiPtt((d) => p.set("ui", d));
    setPttFromUi(true);
    p.set("local", true);
    setPttFromUi(false);
    p.set("local", false);
    bindUiPtt(null);
    setPttFromUi(true);
    expect(seen).toEqual([true, false]);
  });
});
