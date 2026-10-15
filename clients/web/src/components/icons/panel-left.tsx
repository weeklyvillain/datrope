import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge } from "./motions";

const move1 = nudge(-2);

export const PanelLeft = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="panel-left" animate={controls} {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <m.path d="M9 3v18" variants={move1} />
    </IconSvg>
  );
});
PanelLeft.displayName = "PanelLeft";
