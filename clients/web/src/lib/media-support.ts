/** Whether this browser can share a screen (phones mostly can't: no getDisplayMedia). */
export const canShareScreen = (nav: Navigator | undefined = typeof navigator === "undefined" ? undefined : navigator) =>
  !!nav?.mediaDevices && typeof (nav.mediaDevices as MediaDevices).getDisplayMedia === "function";

/** Whether an element can go full screen (not on iPhone Safari). */
export const canFullscreen = (doc: Document | undefined = typeof document === "undefined" ? undefined : document) =>
  !!doc?.fullscreenEnabled;
