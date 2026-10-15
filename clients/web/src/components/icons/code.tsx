import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge } from "./motions";

const move1 = nudge(-2);
const move2 = nudge(2);

export const Code = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="code" animate={controls} {...props}>
      <m.path d="m16 18 6-6-6-6" variants={move2} />
      <m.path d="m8 6-6 6 6 6" variants={move1} />
    </IconSvg>
  );
});
Code.displayName = "Code";
