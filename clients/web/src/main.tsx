import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { LazyMotion, MotionConfig, domAnimation } from "motion/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { router } from "./router";
import "./sounds";
import "./styles.css";
import { registerServiceWorker } from "./sw-register";

registerServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </MotionConfig>
    </LazyMotion>
  </StrictMode>,
);
