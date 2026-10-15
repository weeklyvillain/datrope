import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge, variants } from "./motions";

const move1 = nudge(-2);
const move2 = variants({ x: [0, 2, 0], rotate: [0, 4, 0] });

export const Ticket = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="ticket" animate={controls} {...props}>
      <m.path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" variants={move1} />
      <m.g variants={move2}>
        <path d="M13 5v2" />
        <path d="M13 17v2" />
        <path d="M13 11v2" />
      </m.g>
    </IconSvg>
  );
});
Ticket.displayName = "Ticket";
