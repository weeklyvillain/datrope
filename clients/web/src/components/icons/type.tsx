import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { squash } from "./motions";

const move1 = squash("scaleY");

export const Type = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="type" animate={controls} {...props}>
      <m.g variants={move1} style={{ originX: 0.5, originY: 1 }}>
        <path d="M12 4v16" />
        <path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" />
        <path d="M9 20h6" />
      </m.g>
    </IconSvg>
  );
});
Type.displayName = "Type";
