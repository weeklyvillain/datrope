import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { spin } from "./motions";

const move1 = spin(90);

export const CirclePlus = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="circle-plus" animate={controls} {...props}>
      <circle cx="12" cy="12" r="10" />
      <m.g variants={move1} style={{ originX: 0.5, originY: 0.5 }}>
        <path d="M8 12h8" />
        <path d="M12 8v8" />
      </m.g>
    </IconSvg>
  );
});
CirclePlus.displayName = "CirclePlus";
