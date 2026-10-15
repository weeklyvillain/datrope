import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge } from "./motions";

const move1 = nudge(0, -2);

export const ChevronUp = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="chevron-up" animate={controls} variants={move1} {...props}>
      <path d="m18 15-6-6-6 6" />
    </IconSvg>
  );
});
ChevronUp.displayName = "ChevronUp";
