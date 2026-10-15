import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { squash } from "./motions";

const move1 = squash("scaleX");

export const Globe = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="globe" animate={controls} {...props}>
      <circle cx="12" cy="12" r="10" />
      <m.path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" variants={move1} />
      <path d="M2 12h20" />
    </IconSvg>
  );
});
Globe.displayName = "Globe";
