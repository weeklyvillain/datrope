import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge } from "./motions";

const move1 = nudge(0, -3);

export const MonitorUp = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="monitor-up" animate={controls} {...props}>
      <m.g variants={move1}>
        <path d="m9 10 3-3 3 3" />
        <path d="M12 13V7" />
      </m.g>
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <path d="M12 17v4" />
      <path d="M8 21h8" />
    </IconSvg>
  );
});
MonitorUp.displayName = "MonitorUp";
