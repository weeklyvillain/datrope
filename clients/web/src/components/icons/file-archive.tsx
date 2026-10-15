import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { shake } from "./motions";

export const FileArchive = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="file-archive" animate={controls} variants={shake} {...props}>
      <path d="M13.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v11.5" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M8 12v-1" />
      <path d="M8 18v-2" />
      <path d="M8 7V6" />
      <circle cx="8" cy="20" r="2" />
    </IconSvg>
  );
});
FileArchive.displayName = "FileArchive";
