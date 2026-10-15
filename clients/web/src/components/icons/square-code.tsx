import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge } from "./motions";

const move1 = nudge(-1.5);
const move2 = nudge(1.5);

export const SquareCode = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="square-code" animate={controls} {...props}>
      <m.path d="m10 9-3 3 3 3" variants={move1} />
      <m.path d="m14 15 3-3-3-3" variants={move2} />
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </IconSvg>
  );
});
SquareCode.displayName = "SquareCode";
