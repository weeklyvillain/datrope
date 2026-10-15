import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { spin } from "./motions";

const move1 = spin(90);

export const ListX = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="list-x" animate={controls} {...props}>
      <path d="M16 5H3" />
      <path d="M11 12H3" />
      <path d="M16 19H3" />
      <m.g variants={move1} style={{ originX: 0.5, originY: 0.5 }}>
        <path d="m15.5 9.5 5 5" />
        <path d="m20.5 9.5-5 5" />
      </m.g>
    </IconSvg>
  );
});
ListX.displayName = "ListX";
