import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { squash } from "./motions";

const move1 = squash("scaleX");

export const Minus = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="minus" animate={controls} variants={move1} {...props}>
      <path d="M5 12h14" />
    </IconSvg>
  );
});
Minus.displayName = "Minus";
