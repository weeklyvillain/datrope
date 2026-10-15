import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { hop } from "./motions";

export const ListMusic = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="list-music" animate={controls} {...props}>
      <path d="M16 5H3" />
      <path d="M11 12H3" />
      <path d="M11 19H3" />
      <m.g variants={hop}>
        <path d="M21 16V5" />
        <circle cx="18" cy="16" r="3" />
      </m.g>
    </IconSvg>
  );
});
ListMusic.displayName = "ListMusic";
