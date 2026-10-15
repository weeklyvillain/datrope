// @vitest-environment happy-dom
import { LazyMotion, MotionConfig, domAnimation } from "motion/react";
import { act, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { AnimatedIconProps } from "./icon-base";
import { Check } from "./check";

const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const pointer = (type: string) => Object.assign(new Event(type), { pointerType: "mouse" });

async function mount(Icon: ComponentType<AnimatedIconProps>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig reducedMotion="user">
          <button type="button"><Icon /></button>
        </MotionConfig>
      </LazyMotion>,
    ),
  );
  const button = host.querySelector("button")!;
  const svg = host.querySelector("svg")!;
  const unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { button, svg, unmount };
}

// motion reads prefers-reduced-motion once, on first use, so this file stubs it before anything renders.
vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));

describe("icon motion under reduced motion", () => {
  it("reduced motion: hover leaves the icon completely still", async () => {
    const { button, svg, unmount } = await mount(Check);
    button.dispatchEvent(pointer("pointerenter"));
    const moving = new Set<string>();
    for (let i = 0; i < 15; i++) {
      await wait(30);
      svg.querySelectorAll("*").forEach((e) => {
        const opacity = (e as SVGElement).style.opacity;
        const dash = e.getAttribute("stroke-dasharray");
        if (!["", "1"].includes(opacity) || (dash !== null && dash !== "1 1")) moving.add(`opacity ${opacity}, dasharray ${dash}`);
      });
    }
    expect([...moving]).toEqual([]);
    await unmount();
  });
});
