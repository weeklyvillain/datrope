import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { bounce } from "./motions";

const move1 = bounce(0);
const move2 = bounce(0.08);
const move3 = bounce(0.16);

export const Ellipsis = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="ellipsis" animate={controls} {...props}>
      <m.circle cx="12" cy="12" r="1" variants={move2} />
      <m.circle cx="19" cy="12" r="1" variants={move3} />
      <m.circle cx="5" cy="12" r="1" variants={move1} />
    </IconSvg>
  );
});
Ellipsis.displayName = "Ellipsis";
