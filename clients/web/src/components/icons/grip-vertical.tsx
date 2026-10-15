import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { blip } from "./motions";

const move1 = blip(0);
const move2 = blip(0.04);
const move3 = blip(0.1);
const move4 = blip(0.14);
const move5 = blip(0.2);
const move6 = blip(0.24);

export const GripVertical = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="grip-vertical" animate={controls} {...props}>
      <m.circle cx="9" cy="12" r="1" variants={move3} />
      <m.circle cx="9" cy="5" r="1" variants={move1} />
      <m.circle cx="9" cy="19" r="1" variants={move5} />
      <m.circle cx="15" cy="12" r="1" variants={move4} />
      <m.circle cx="15" cy="5" r="1" variants={move2} />
      <m.circle cx="15" cy="19" r="1" variants={move6} />
    </IconSvg>
  );
});
GripVertical.displayName = "GripVertical";
