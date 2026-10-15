import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge } from "./motions";

const move1 = nudge(-3);

export const ArrowLeft = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="arrow-left" animate={controls} variants={move1} {...props}>
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </IconSvg>
  );
});
ArrowLeft.displayName = "ArrowLeft";
