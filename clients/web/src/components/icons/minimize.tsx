import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge } from "./motions";

const move1 = nudge(2, 2);
const move2 = nudge(-2, 2);
const move3 = nudge(2, -2);
const move4 = nudge(-2, -2);

export const Minimize = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="minimize" animate={controls} {...props}>
      <m.path d="M8 3v3a2 2 0 0 1-2 2H3" variants={move1} />
      <m.path d="M21 8h-3a2 2 0 0 1-2-2V3" variants={move2} />
      <m.path d="M3 16h3a2 2 0 0 1 2 2v3" variants={move3} />
      <m.path d="M16 21v-3a2 2 0 0 1 2-2h3" variants={move4} />
    </IconSvg>
  );
});
Minimize.displayName = "Minimize";
