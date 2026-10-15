import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge } from "./motions";

const move1 = nudge(-2);

export const ChevronLeft = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="chevron-left" animate={controls} variants={move1} {...props}>
      <path d="m15 18-6-6 6-6" />
    </IconSvg>
  );
});
ChevronLeft.displayName = "ChevronLeft";
