import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge } from "./motions";

const move1 = nudge(0, 3);

export const ArrowDown = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="arrow-down" animate={controls} variants={move1} {...props}>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </IconSvg>
  );
});
ArrowDown.displayName = "ArrowDown";
