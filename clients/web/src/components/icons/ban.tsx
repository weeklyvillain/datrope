import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { draw } from "./motions";

const move1 = draw();
const move2 = draw(0.2);

export const Ban = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="ban" animate={controls} {...props}>
      <m.circle cx="12" cy="12" r="10" variants={move1} />
      <m.path d="M4.929 4.929 19.07 19.071" variants={move2} />
    </IconSvg>
  );
});
Ban.displayName = "Ban";
