import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { bounce } from "./motions";

const move1 = bounce(0, "x");
const move2 = bounce(0.05, "x");
const move3 = bounce(0.1, "x");

export const List = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="list" animate={controls} {...props}>
      <path d="M3 5h.01" />
      <path d="M3 12h.01" />
      <path d="M3 19h.01" />
      <m.path d="M8 5h13" variants={move1} />
      <m.path d="M8 12h13" variants={move2} />
      <m.path d="M8 19h13" variants={move3} />
    </IconSvg>
  );
});
List.displayName = "List";
