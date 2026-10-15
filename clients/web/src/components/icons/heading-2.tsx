import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { hop } from "./motions";

export const Heading2 = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="heading-2" animate={controls} {...props}>
      <path d="M4 12h8" />
      <path d="M4 18V6" />
      <path d="M12 18V6" />
      <m.path d="M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1" variants={hop} />
    </IconSvg>
  );
});
Heading2.displayName = "Heading2";
