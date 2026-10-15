import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { draw } from "./motions";

const move1 = draw(0.1);
const move2 = draw(0.2);
const move3 = draw(0.3);

export const FileText = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="file-text" animate={controls} {...props}>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <m.path d="M10 9H8" variants={move1} />
      <m.path d="M16 13H8" variants={move2} />
      <m.path d="M16 17H8" variants={move3} />
    </IconSvg>
  );
});
FileText.displayName = "FileText";
