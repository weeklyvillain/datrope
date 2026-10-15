import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { bounce } from "./motions";

const move1 = bounce(0, "x");
const move2 = bounce(0.05, "x");
const move3 = bounce(0.1, "x");

export const ListOrdered = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="list-ordered" animate={controls} {...props}>
      <m.path d="M11 5h10" variants={move1} />
      <m.path d="M11 12h10" variants={move2} />
      <m.path d="M11 19h10" variants={move3} />
      <path d="M4 4h1v5" />
      <path d="M4 9h2" />
      <path d="M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02" />
    </IconSvg>
  );
});
ListOrdered.displayName = "ListOrdered";
