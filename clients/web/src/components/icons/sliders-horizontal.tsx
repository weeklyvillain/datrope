import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge } from "./motions";

const move1 = nudge(-4);
const move2 = nudge(5);
const move3 = nudge(-6);

export const SlidersHorizontal = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="sliders-horizontal" animate={controls} {...props}>
      <path d="M10 5H3" />
      <path d="M12 19H3" />
      <m.path d="M14 3v4" variants={move1} />
      <m.path d="M16 17v4" variants={move3} />
      <path d="M21 12h-9" />
      <path d="M21 19h-5" />
      <path d="M21 5h-7" />
      <m.path d="M8 10v4" variants={move2} />
      <path d="M8 12H3" />
    </IconSvg>
  );
});
SlidersHorizontal.displayName = "SlidersHorizontal";
