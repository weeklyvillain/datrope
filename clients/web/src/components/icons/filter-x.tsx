import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { spin } from "./motions";

const move1 = spin(90);

export const FilterX = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="filter-x" animate={controls} {...props}>
      <path d="M12.531 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14v6a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341l.427-.473" />
      <m.g variants={move1} style={{ originX: 0.5, originY: 0.5 }}>
        <path d="m16.5 3.5 5 5" />
        <path d="m21.5 3.5-5 5" />
      </m.g>
    </IconSvg>
  );
});
FilterX.displayName = "FilterX";
