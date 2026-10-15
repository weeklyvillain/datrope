import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { spin } from "./motions";

const move1 = spin(90);

export const Plus = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="plus" animate={controls} variants={move1} {...props}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </IconSvg>
  );
});
Plus.displayName = "Plus";
