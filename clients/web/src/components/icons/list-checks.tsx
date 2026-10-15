import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { draw } from "./motions";

const move1 = draw();
const move2 = draw(0.15);

export const ListChecks = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="list-checks" animate={controls} {...props}>
      <path d="M13 5h8" />
      <path d="M13 12h8" />
      <path d="M13 19h8" />
      <m.path d="m3 17 2 2 4-4" variants={move2} />
      <m.path d="m3 7 2 2 4-4" variants={move1} />
    </IconSvg>
  );
});
ListChecks.displayName = "ListChecks";
