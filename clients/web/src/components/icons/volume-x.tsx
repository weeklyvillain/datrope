import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { spin } from "./motions";

const move1 = spin(90);

export const VolumeX = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="volume-x" animate={controls} {...props}>
      <path d="M11 4.702a.7.7 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.7.7 0 0 0 11 19.298z" />
      <m.g variants={move1} style={{ originX: 0.5, originY: 0.5 }}>
        <path d="m16.5 14.5 5-5" />
        <path d="m16.5 9.5 5 5" />
      </m.g>
    </IconSvg>
  );
});
VolumeX.displayName = "VolumeX";
