import { describe, expect, it } from "vitest";
import { errorMessage, errorReporter } from "./global-errors";

describe("errorReporter", () => {
  const setup = () => {
    let t = 0;
    const shown: string[] = [];
    const report = errorReporter((m) => shown.push(m), () => t);
    return { shown, report, advance: (ms: number) => { t += ms; } };
  };

  it("shows each error's message", () => {
    const { shown, report } = setup();
    report(new Error("couldn't load reactions"));
    report("plain string");
    expect(shown).toEqual(["couldn't load reactions", "plain string"]);
  });

  it("shows the same error once per few seconds", () => {
    const { shown, report, advance } = setup();
    report(new Error("same"));
    advance(1000);
    report(new Error("same"));
    advance(5000);
    report(new Error("same"));
    expect(shown).toEqual(["same", "same"]);
  });

  it("skips cancelled requests and ResizeObserver noise", () => {
    const { shown, report } = setup();
    report(new DOMException("The user aborted a request.", "AbortError"));
    report("ResizeObserver loop completed with undelivered notifications.");
    expect(shown).toEqual([]);
  });
});

describe("errorMessage", () => {
  it("keeps it to one short line", () => {
    expect(errorMessage(new Error("x".repeat(500)))).toHaveLength(200);
    expect(errorMessage({ weird: true })).toBe("");
  });
});
