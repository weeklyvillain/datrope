import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge } from "./motions";

const move1 = nudge(3);
const move2 = nudge(-3);

export const Settings2 = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="settings-2" animate={controls} {...props}>
      <path d="M14 17H5" />
      <path d="M19 7h-9" />
      <m.circle cx="17" cy="17" r="3" variants={move2} />
      <m.circle cx="7" cy="7" r="3" variants={move1} />
    </IconSvg>
  );
});
Settings2.displayName = "Settings2";
