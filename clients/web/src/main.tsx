import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { ErrorBoundary } from "@/components/error-boundary";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { installGlobalErrorHandlers } from "@/lib/global-errors";
import { Crash } from "./pages/errors";
import { router } from "./router";
import "./sounds";
import "./styles.css";
import { registerServiceWorker } from "./sw-register";

registerServiceWorker();
installGlobalErrorHandlers();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary fallback={<Crash />}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </ErrorBoundary>
    <Toaster />
  </StrictMode>,
);
