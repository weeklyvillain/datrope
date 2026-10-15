import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { variants } from "./motions";

const move1 = variants({ y: [0, 2, 0, 0] }, { duration: 0.5, times: [0, 0.2, 0.5, 1] });
const move2 = variants({ y: [0, 0, 2, 0] }, { duration: 0.5, times: [0, 0.2, 0.5, 1] });

export const Pause = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="pause" animate={controls} {...props}>
      <m.rect x="14" y="3" width="5" height="18" rx="1" variants={move2} />
      <m.rect x="5" y="3" width="5" height="18" rx="1" variants={move1} />
    </IconSvg>
  );
});
Pause.displayName = "Pause";
