import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { draw } from "./motions";

const move1 = draw();
const move2 = draw(0.3);

export const AtSign = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="at-sign" animate={controls} {...props}>
      <m.circle cx="12" cy="12" r="4" variants={move1} />
      <m.path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" variants={move2} />
    </IconSvg>
  );
});
AtSign.displayName = "AtSign";
