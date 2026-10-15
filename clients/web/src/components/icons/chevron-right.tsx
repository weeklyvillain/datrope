import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge } from "./motions";

const move1 = nudge(2);

export const ChevronRight = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="chevron-right" animate={controls} variants={move1} {...props}>
      <path d="m9 18 6-6-6-6" />
    </IconSvg>
  );
});
ChevronRight.displayName = "ChevronRight";
