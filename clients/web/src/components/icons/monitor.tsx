import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { variants } from "./motions";

const move1 = variants({ scale: [1, 0.92, 1.04, 1] });

export const Monitor = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="monitor" animate={controls} {...props}>
      <m.rect width="20" height="14" x="2" y="3" rx="2" variants={move1} />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </IconSvg>
  );
});
Monitor.displayName = "Monitor";
