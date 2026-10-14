import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { answerScreenPick, fetchScreenPick, type ScreenPickRequest } from "./rail-api";
import { ScreenPicker } from "./ScreenPicker";
import "./rail.css";

/**
 * The picker webview: the shell opens it over the whole window while a server page asks for a source, and closes
 * it once answered.
 */
function Picker() {
  const [request, setRequest] = useState<ScreenPickRequest>();

  useEffect(() => {
    void fetchScreenPick().then((r) => {
      if (r) setRequest(r);
      else void answerScreenPick(null, null); // answered or replaced before this loaded
    });
  }, []);

  return (
    <ScreenPicker request={request} onDone={(id, settings) => {
      setRequest(undefined);
      void answerScreenPick(id, settings);
    }} />
  );
}

createRoot(document.getElementById("root")!).render(<Picker />);
