import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { blink } from "./motions";

const move1 = blink(0.00);
const move2 = blink(0.05);
const move3 = blink(0.10);
const move4 = blink(0.15);
const move5 = blink(0.20);
const move6 = blink(0.25);
const move7 = blink(0.30);
const move8 = blink(0.35);

export const Keyboard = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="keyboard" animate={controls} {...props}>
      <m.path d="M10 8h.01" variants={move1} />
      <m.path d="M12 12h.01" variants={move2} />
      <m.path d="M14 8h.01" variants={move3} />
      <m.path d="M16 12h.01" variants={move4} />
      <m.path d="M18 8h.01" variants={move5} />
      <m.path d="M6 8h.01" variants={move6} />
      <m.path d="M7 16h10" variants={move7} />
      <m.path d="M8 12h.01" variants={move8} />
      <rect width="20" height="16" x="2" y="4" rx="2" />
    </IconSvg>
  );
});
Keyboard.displayName = "Keyboard";
