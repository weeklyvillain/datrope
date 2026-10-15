import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { draw } from "./motions";

const move1 = draw(0.15);

export const MicOff = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="mic-off" animate={controls} {...props}>
      <path d="M12 19v3" />
      <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
      <path d="M16.95 16.95A7 7 0 0 1 5 12v-2" />
      <path d="M18.89 13.23A7 7 0 0 0 19 12v-2" />
      <m.path d="m2 2 20 20" variants={move1} />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
    </IconSvg>
  );
});
MicOff.displayName = "MicOff";
