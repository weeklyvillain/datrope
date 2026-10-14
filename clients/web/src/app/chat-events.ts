// Tiny EventTarget wrappers: keyboard shortcuts (use-shortcuts) ask the message list and channel view to act.
const bus = new EventTarget();
const on = (type: string, cb: () => void) => {
  bus.addEventListener(type, cb);
  return () => bus.removeEventListener(type, cb);
};

export const emitPresent = (channelId: string) => bus.dispatchEvent(new Event(`present:${channelId}`));
export const onPresent = (channelId: string, cb: () => void) => on(`present:${channelId}`, cb);
export const emitEditLast = (channelId: string) => bus.dispatchEvent(new Event(`edit-last:${channelId}`));
export const onEditLast = (channelId: string, cb: () => void) => on(`edit-last:${channelId}`, cb);
export const emitToggleMembers = () => bus.dispatchEvent(new Event("toggle-members"));
export const onToggleMembers = (cb: () => void) => on("toggle-members", cb);

// Edit one message: the row may not be rendered yet (virtualized), so the request waits for it to mount.
let pendingEdit: string | undefined;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
export const clearEditRequest = () => {
  pendingEdit = undefined;
  clearTimeout(pendingTimer);
};
export const requestEdit = (messageId: string) => {
  clearEditRequest();
  pendingEdit = messageId;
  pendingTimer = setTimeout(clearEditRequest, 2000); // a row that never mounts must not enter edit mode later
  bus.dispatchEvent(new Event(`edit:${messageId}`));
};
export function onEditRequest(messageId: string, cb: () => void) {
  const run = () => {
    if (pendingEdit !== messageId) return;
    clearEditRequest();
    cb();
  };
  run();
  return on(`edit:${messageId}`, run);
}
