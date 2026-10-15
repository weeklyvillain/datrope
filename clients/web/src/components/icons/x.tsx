import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { spin } from "./motions";

const move1 = spin(90);

export const X = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="x" animate={controls} variants={move1} {...props}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </IconSvg>
  );
});
X.displayName = "X";
