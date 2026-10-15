import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { variants } from "./motions";

const move1 = variants({ scale: [0, 1.15, 1], rotate: [-90, 0, 0], opacity: [0, 1, 1] }, { delay: 0.1, duration: 0.45, times: [0, 0.7, 1] });

export const UserPlus = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="user-plus" animate={controls} {...props}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <m.g variants={move1} style={{ originX: 0.5, originY: 0.5 }}>
        <line x1="19" x2="19" y1="8" y2="14" />
        <line x1="22" x2="16" y1="11" y2="11" />
      </m.g>
    </IconSvg>
  );
});
UserPlus.displayName = "UserPlus";
