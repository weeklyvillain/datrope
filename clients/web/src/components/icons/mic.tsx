import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { variants } from "./motions";

const move1 = variants({ y: [0, -3, 0, -2, 0] });

export const Mic = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="mic" animate={controls} {...props}>
      <path d="M12 19v3" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <m.rect x="9" y="2" width="6" height="13" rx="3" variants={move1} />
    </IconSvg>
  );
});
Mic.displayName = "Mic";
