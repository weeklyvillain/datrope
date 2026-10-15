import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { router } from "./router";
import "./sounds";
import "./styles.css";
import { registerServiceWorker } from "./sw-register";

registerServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <RouterProvider router={router} />
      <Toaster />
    </TooltipProvider>
  </StrictMode>,
);
