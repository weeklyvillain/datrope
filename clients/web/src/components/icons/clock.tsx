import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { spin } from "./motions";

const move1 = spin(360);

export const Clock = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="clock" animate={controls} {...props}>
      <circle cx="12" cy="12" r="10" />
      <m.path d="M12 6v6l4 2" variants={move1} style={{ originX: 0, originY: 0.75 }} />
    </IconSvg>
  );
});
Clock.displayName = "Clock";
