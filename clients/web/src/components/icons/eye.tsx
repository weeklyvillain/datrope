import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { variants } from "./motions";

const move1 = variants({ scaleY: [1, 0.1, 1], opacity: [1, 0.3, 1] }, { duration: 0.4 });
const move2 = variants({ scale: [1, 0.3, 1], opacity: [1, 0.3, 1] }, { duration: 0.4 });

export const Eye = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="eye" animate={controls} {...props}>
      <m.path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" variants={move1} />
      <m.circle cx="12" cy="12" r="3" variants={move2} />
    </IconSvg>
  );
});
Eye.displayName = "Eye";
