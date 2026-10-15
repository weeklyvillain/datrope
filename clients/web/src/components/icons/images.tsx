import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge } from "./motions";

const move1 = nudge(-1.5, 1.5);
const move2 = nudge(1, -1);

export const Images = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="images" animate={controls} {...props}>
      <m.g variants={move2}>
        <path d="m22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16" />
        <circle cx="13" cy="7" r="1" fill="currentColor" />
        <rect x="8" y="2" width="14" height="14" rx="2" />
      </m.g>
      <m.path d="M4 8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2" variants={move1} />
    </IconSvg>
  );
});
Images.displayName = "Images";
