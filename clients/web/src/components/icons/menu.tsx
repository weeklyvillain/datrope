import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { bounce } from "./motions";

const move1 = bounce(0, "x");
const move2 = bounce(0.06, "x");
const move3 = bounce(0.12, "x");

export const Menu = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="menu" animate={controls} {...props}>
      <m.path d="M4 5h16" variants={move1} />
      <m.path d="M4 12h16" variants={move2} />
      <m.path d="M4 19h16" variants={move3} />
    </IconSvg>
  );
});
Menu.displayName = "Menu";
