import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge, variants } from "./motions";

const move1 = variants({ rotate: [0, -3, 1, -2, 0], scale: [1, 0.95, 1.05, 0.98, 1] });
const move2 = nudge(0, -2);

export const Lock = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="lock" animate={controls} variants={move1} {...props}>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <m.path d="M7 11V7a5 5 0 0 1 10 0v4" variants={move2} />
    </IconSvg>
  );
});
Lock.displayName = "Lock";
