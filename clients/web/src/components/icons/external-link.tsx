import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge } from "./motions";

const move1 = nudge(2, -2);

export const ExternalLink = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="external-link" animate={controls} {...props}>
      <m.g variants={move1}>
        <path d="M15 3h6v6" />
        <path d="M10 14 21 3" />
      </m.g>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </IconSvg>
  );
});
ExternalLink.displayName = "ExternalLink";
