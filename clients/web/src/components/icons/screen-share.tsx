import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge } from "./motions";

const move1 = nudge(2, -2);

export const ScreenShare = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="screen-share" animate={controls} {...props}>
      <path d="M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
      <m.g variants={move1}>
        <path d="m17 8 5-5" />
        <path d="M17 3h5v5" />
      </m.g>
    </IconSvg>
  );
});
ScreenShare.displayName = "ScreenShare";
