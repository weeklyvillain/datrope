import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { variants } from "./motions";

const move1 = variants({ x: [0, 3, -3, 0], y: [0, -3, 3, 0], opacity: [1, 0, 0, 1] }, { times: [0, 0.45, 0.46, 1] });

export const Send = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="send" animate={controls} {...props}>
      <m.g variants={move1}>
        <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
        <path d="m21.854 2.147-10.94 10.939" />
      </m.g>
    </IconSvg>
  );
});
Send.displayName = "Send";
