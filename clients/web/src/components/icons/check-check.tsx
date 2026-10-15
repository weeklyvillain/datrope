import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { draw } from "./motions";

const move1 = draw();
const move2 = draw(0.1);

export const CheckCheck = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="check-check" animate={controls} {...props}>
      <m.path d="M18 6 7 17l-5-5" variants={move1} />
      <m.path d="m22 10-7.5 7.5L13 16" variants={move2} />
    </IconSvg>
  );
});
CheckCheck.displayName = "CheckCheck";
