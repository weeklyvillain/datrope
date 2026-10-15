import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { draw } from "./motions";

const move1 = draw();

export const Check = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="check" animate={controls} {...props}>
      <m.path d="M20 6 9 17l-5-5" variants={move1} />
    </IconSvg>
  );
});
Check.displayName = "Check";
