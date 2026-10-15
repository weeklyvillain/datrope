import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { nudge } from "./motions";

const move1 = nudge(0, -3);

export const Upload = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="upload" animate={controls} {...props}>
      <m.g variants={move1}>
        <path d="M12 3v12" />
        <path d="m17 8-5-5-5 5" />
      </m.g>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    </IconSvg>
  );
});
Upload.displayName = "Upload";
