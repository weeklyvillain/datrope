import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge } from "./motions";

const move1 = nudge(0, -1.5);

export const UserRound = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="user-round" animate={controls} {...props}>
      <m.circle cx="12" cy="8" r="5" variants={move1} />
      <path d="M20 21a8 8 0 0 0-16 0" />
    </IconSvg>
  );
});
UserRound.displayName = "UserRound";
