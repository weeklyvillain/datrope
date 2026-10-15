import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge } from "./motions";

const move1 = nudge(2, -2);
const move2 = nudge(-2, 2);

export const Maximize2 = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="maximize-2" animate={controls} {...props}>
      <m.g variants={move1}>
        <path d="M15 3h6v6" />
        <path d="m21 3-7 7" />
      </m.g>
      <m.g variants={move2}>
        <path d="m3 21 7-7" />
        <path d="M9 21H3v-6" />
      </m.g>
    </IconSvg>
  );
});
Maximize2.displayName = "Maximize2";
