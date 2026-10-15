import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { variants } from "./motions";

const move1 = variants({ x: [0, 1.5, -0.5, 0], y: [0, -1.5, 0.5, 0] });
const move2 = variants({ x: [0, -1.5, 0.5, 0], y: [0, 1.5, -0.5, 0] });

export const Link = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="link" animate={controls} {...props}>
      <m.path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" variants={move1} />
      <m.path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" variants={move2} />
    </IconSvg>
  );
});
Link.displayName = "Link";
