import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { variants } from "./motions";

const move1 = variants({ x: [0, 11, 11, 0] }, { duration: 0.7, times: [0, 0.4, 0.6, 1] });
const move2 = variants({ y: [0, 11, 11, 0] }, { duration: 0.7, times: [0, 0.4, 0.6, 1] });
const move3 = variants({ x: [0, -11, -11, 0] }, { duration: 0.7, times: [0, 0.4, 0.6, 1] });
const move4 = variants({ y: [0, -11, -11, 0] }, { duration: 0.7, times: [0, 0.4, 0.6, 1] });

export const LayoutGrid = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="layout-grid" animate={controls} {...props}>
      <m.rect width="7" height="7" x="3" y="3" rx="1" variants={move1} />
      <m.rect width="7" height="7" x="14" y="3" rx="1" variants={move2} />
      <m.rect width="7" height="7" x="14" y="14" rx="1" variants={move3} />
      <m.rect width="7" height="7" x="3" y="14" rx="1" variants={move4} />
    </IconSvg>
  );
});
LayoutGrid.displayName = "LayoutGrid";
