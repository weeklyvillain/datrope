import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge } from "./motions";

const move1 = nudge(-2.5, -2.5);
const move2 = nudge(1, 1);

export const Copy = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="copy" animate={controls} {...props}>
      <m.rect width="14" height="14" x="8" y="8" rx="2" ry="2" variants={move2} />
      <m.path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" variants={move1} />
    </IconSvg>
  );
});
Copy.displayName = "Copy";
