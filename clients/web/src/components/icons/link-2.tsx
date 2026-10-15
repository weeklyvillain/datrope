import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { variants } from "./motions";

const move1 = variants({ x: [0, -1.5, 0.5, 0] });
const move2 = variants({ x: [0, 1.5, -0.5, 0] });

export const Link2 = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="link-2" animate={controls} {...props}>
      <m.path d="M9 17H7A5 5 0 0 1 7 7h2" variants={move1} />
      <m.path d="M15 7h2a5 5 0 1 1 0 10h-2" variants={move2} />
      <line x1="8" x2="16" y1="12" y2="12" />
    </IconSvg>
  );
});
Link2.displayName = "Link2";
