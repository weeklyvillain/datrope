import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { spin } from "./motions";

const move1 = spin(360);

export const Timer = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="timer" animate={controls} {...props}>
      <line x1="10" x2="14" y1="2" y2="2" />
      <m.line x1="12" x2="15" y1="14" y2="11" variants={move1} style={{ originX: 0, originY: 1 }} />
      <circle cx="12" cy="14" r="8" />
    </IconSvg>
  );
});
Timer.displayName = "Timer";
