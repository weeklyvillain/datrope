import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { variants } from "./motions";

const move1 = variants({ rotate: [0, -8, 8, 0], scale: [1, 1.08, 1.08, 1] });
const move2 = variants({ scaleY: [1, 0.2, 1] }, { duration: 0.4 });

export const Smile = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="smile" animate={controls} variants={move1} {...props}>
      <m.g variants={move2}>
        <path d="M15 10V9" />
        <path d="M9 10V9" />
      </m.g>
      <path d="M16.472 15a6 6 0 01-8.943 0" />
      <circle cx="12" cy="12" r="10" />
    </IconSvg>
  );
});
Smile.displayName = "Smile";
