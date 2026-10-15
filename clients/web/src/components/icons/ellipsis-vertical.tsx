import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { variants } from "./motions";

const move1 = variants({ scale: [1, 1.6, 1] }, { duration: 0.45 });
const move2 = variants({ scale: [1, 1.6, 1] }, { delay: 0.08, duration: 0.45 });
const move3 = variants({ scale: [1, 1.6, 1] }, { delay: 0.16, duration: 0.45 });

export const EllipsisVertical = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="ellipsis-vertical" animate={controls} {...props}>
      <m.circle cx="12" cy="12" r="1" variants={move2} />
      <m.circle cx="12" cy="5" r="1" variants={move1} />
      <m.circle cx="12" cy="19" r="1" variants={move3} />
    </IconSvg>
  );
});
EllipsisVertical.displayName = "EllipsisVertical";
