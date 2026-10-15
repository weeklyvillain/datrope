import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { hop } from "./motions";

export const Heading1 = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="heading-1" animate={controls} {...props}>
      <path d="M4 12h8" />
      <path d="M4 18V6" />
      <path d="M12 18V6" />
      <m.path d="m17 12 3-2v8" variants={hop} />
    </IconSvg>
  );
});
Heading1.displayName = "Heading1";
