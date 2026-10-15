import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { blink } from "./motions";

const move1 = blink(0);
const move2 = blink(0.12);

export const Rss = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="rss" animate={controls} {...props}>
      <m.path d="M4 11a9 9 0 0 1 9 9" variants={move1} />
      <m.path d="M4 4a16 16 0 0 1 16 16" variants={move2} />
      <circle cx="5" cy="19" r="1" />
    </IconSvg>
  );
});
Rss.displayName = "Rss";
