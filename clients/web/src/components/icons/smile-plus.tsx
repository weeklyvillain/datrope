import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { tilt, spin } from "./motions";

const move1 = spin(90);

export const SmilePlus = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="smile-plus" animate={controls} variants={tilt} {...props}>
      <path d="M13.267 2.08a10 10 0 108.653 8.653" />
      <path d="M15 10V9" />
      <m.g variants={move1} style={{ originX: 0.5, originY: 0.5 }}>
        <path d="M16 5h6" />
        <path d="M19 2v6" />
      </m.g>
      <path d="M16.472 15a6 6 0 01-8.943 0" />
      <path d="M9 10V9" />
    </IconSvg>
  );
});
SmilePlus.displayName = "SmilePlus";
