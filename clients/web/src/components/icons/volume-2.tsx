import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { blink } from "./motions";

const move1 = blink(0);
const move2 = blink(0.12);

export const Volume2 = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="volume-2" animate={controls} {...props}>
      <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />
      <m.path d="M16 9a5 5 0 0 1 0 6" variants={move1} />
      <m.path d="M19.364 18.364a9 9 0 0 0 0-12.728" variants={move2} />
    </IconSvg>
  );
});
Volume2.displayName = "Volume2";
