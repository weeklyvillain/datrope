import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge } from "./motions";

const move1 = nudge(0, 3);

export const Download = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="download" animate={controls} {...props}>
      <m.g variants={move1}>
        <path d="M12 15V3" />
        <path d="m7 10 5 5 5-5" />
      </m.g>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    </IconSvg>
  );
});
Download.displayName = "Download";
