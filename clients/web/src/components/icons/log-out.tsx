import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge } from "./motions";

const move1 = nudge(3);

export const LogOut = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="log-out" animate={controls} {...props}>
      <m.g variants={move1}>
        <path d="m16 17 5-5-5-5" />
        <path d="M21 12H9" />
      </m.g>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    </IconSvg>
  );
});
LogOut.displayName = "LogOut";
