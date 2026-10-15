import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge } from "./motions";

const move1 = nudge(-2);
const move2 = nudge(2);

export const ArrowLeftRight = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="arrow-left-right" animate={controls} {...props}>
      <m.g variants={move1}>
        <path d="M8 3 4 7l4 4" />
        <path d="M4 7h16" />
      </m.g>
      <m.g variants={move2}>
        <path d="m16 21 4-4-4-4" />
        <path d="M20 17H4" />
      </m.g>
    </IconSvg>
  );
});
ArrowLeftRight.displayName = "ArrowLeftRight";
