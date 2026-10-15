// @vitest-environment happy-dom
import { LazyMotion, MotionGlobalConfig, domAnimation } from "motion/react";
import { act, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnimatedIconProps } from "./icon-base";

// Every icon file except the base. Each exports exactly one component.
const files = import.meta.glob<Record<string, ComponentType<AnimatedIconProps>>>(["./*.tsx", "!./icon-base.tsx", "!./*.test.tsx"], { eager: true });
const icons = Object.entries(files).map(([path, mod]) => {
  const [name, Icon] = Object.entries(mod)[0];
  return { kebab: path.slice(2, -4), name, Icon };
});

const rested = (el: Element) => {
  const s = (el as SVGElement).style;
  return (s.transform === "" || s.transform === "none") && (s.opacity === "" || s.opacity === "1");
};

const tick = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

async function hover(Icon: ComponentType<AnimatedIconProps>, leave: boolean) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <LazyMotion features={domAnimation} strict>
      <button type="button"><Icon /></button>
    </LazyMotion>,
  ));
  const button = host.querySelector("button")!;
  button.dispatchEvent(Object.assign(new Event("pointerenter"), { pointerType: "mouse" }));
  if (leave) button.dispatchEvent(Object.assign(new Event("pointerleave"), { pointerType: "mouse" }));
  await tick(50);
  const unrested = [...host.querySelectorAll("svg, svg *")].filter((el) => !rested(el)).map((el) => `${el.tagName}: ${(el as SVGElement).style.cssText}`);
  await act(async () => root.unmount());
  host.remove();
  return unrested;
}

describe("animated icons", () => {
  beforeAll(() => {
    MotionGlobalConfig.instantAnimations = true;
  });
  afterAll(() => {
    MotionGlobalConfig.instantAnimations = false;
  });

  it("found icon files", () => {
    expect(icons.length).toBeGreaterThan(0);
  });

  it.each(icons)("$kebab renders a lucide-shaped, hidden svg with the passed class", ({ kebab, Icon }) => {
    const out = renderToStaticMarkup(<Icon className="size-5 text-primary" />);
    expect(out).toMatch(/^<svg/);
    expect(out).toContain(`lucide-${kebab}`);
    expect(out).toContain("size-5 text-primary");
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain('width="24"');
  });

  it.each(icons)("$kebab rests after its animation", async ({ Icon }) => {
    expect(await hover(Icon, false)).toEqual([]);
  });

  it.each(icons)("$kebab: stop right after start rests every icon", async ({ Icon }) => {
    expect(await hover(Icon, true)).toEqual([]);
  });
});
