import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge } from "./motions";

const move1 = nudge(0, -3);

export const ArrowUp = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="arrow-up" animate={controls} variants={move1} {...props}>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </IconSvg>
  );
});
ArrowUp.displayName = "ArrowUp";
