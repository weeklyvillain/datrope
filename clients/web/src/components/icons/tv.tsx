import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { hop } from "./motions";

export const Tv = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="tv" animate={controls} variants={hop} {...props}>
      <path d="m17 2-5 5-5-5" />
      <rect width="20" height="15" x="2" y="7" rx="2" />
    </IconSvg>
  );
});
Tv.displayName = "Tv";
