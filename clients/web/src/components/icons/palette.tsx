import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { draw, variants } from "./motions";

const move1 = draw();
const move2 = variants({ scale: [0, 1.4, 1] }, { delay: 0.30, duration: 0.4 });
const move3 = variants({ scale: [0, 1.4, 1] }, { delay: 0.38, duration: 0.4 });
const move4 = variants({ scale: [0, 1.4, 1] }, { delay: 0.46, duration: 0.4 });
const move5 = variants({ scale: [0, 1.4, 1] }, { delay: 0.54, duration: 0.4 });

export const Palette = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="palette" animate={controls} {...props}>
      <m.path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z" variants={move1} />
      <m.circle cx="13.5" cy="6.5" r=".5" fill="currentColor" variants={move2} />
      <m.circle cx="17.5" cy="10.5" r=".5" fill="currentColor" variants={move3} />
      <m.circle cx="6.5" cy="12.5" r=".5" fill="currentColor" variants={move4} />
      <m.circle cx="8.5" cy="7.5" r=".5" fill="currentColor" variants={move5} />
    </IconSvg>
  );
});
Palette.displayName = "Palette";
