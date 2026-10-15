import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { shake } from "./motions";

export const ScreenShareOff = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="screen-share-off" animate={controls} variants={shake} {...props}>
      <path d="M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
      <path d="m22 3-5 5" />
      <path d="m17 3 5 5" />
    </IconSvg>
  );
});
ScreenShareOff.displayName = "ScreenShareOff";
