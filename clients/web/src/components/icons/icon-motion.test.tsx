// @vitest-environment happy-dom
import { LazyMotion, MotionConfig, domAnimation } from "motion/react";
import { act, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { AnimatedIconProps } from "./icon-base";
import { RefreshCw } from "./refresh-cw";

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

const rotation = (el: Element) => Number(/rotate\((-?[\d.]+)deg\)/.exec((el as SVGElement).style.transform)?.[1] ?? 0);

describe("icon motion", () => {
  it("leaving mid-spin never spins backwards", async () => {
    const { button, svg, unmount } = await mount(RefreshCw);
    button.dispatchEvent(pointer("pointerenter"));
    await wait(200);
    const atLeave = rotation(svg);
    expect(atLeave).toBeGreaterThan(20);
    button.dispatchEvent(pointer("pointerleave"));
    const seen: number[] = [];
    for (let i = 0; i < 25; i++) {
      await wait(30);
      seen.push(rotation(svg));
    }
    // The spin plays on to its end (overshoot settling is fine) and transitionEnd snaps it to 0; it never unwinds.
    const beforeSnap = seen.slice(0, seen.indexOf(0) === -1 ? seen.length : seen.indexOf(0));
    for (const r of beforeSnap) expect(r).toBeGreaterThanOrEqual(Math.min(atLeave, 360) - 1);
    expect(seen.at(-1)).toBe(0);
    await unmount();
  });
});
