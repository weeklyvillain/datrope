import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { spin } from "./motions";

const move1 = spin(90);

export const ListPlus = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="list-plus" animate={controls} {...props}>
      <path d="M16 5H3" />
      <path d="M11 12H3" />
      <path d="M16 19H3" />
      <m.g variants={move1} style={{ originX: 0.5, originY: 0.5 }}>
        <path d="M18 9v6" />
        <path d="M21 12h-6" />
      </m.g>
    </IconSvg>
  );
});
ListPlus.displayName = "ListPlus";
