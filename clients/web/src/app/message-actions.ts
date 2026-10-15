export type MessageAction = "react" | "reply" | "thread" | "edit" | "copy" | "pin" | "album" | "delete";

/** What the phone action sheet offers for a message, in order; null when it offers nothing. */
export function messageActions(
  m: { pending?: boolean; deleted?: boolean; kind?: string; content: string; attachments?: unknown[] | null },
  can: { reply: boolean; react: boolean; thread: boolean; hasThread: boolean; edit: boolean; pin: boolean; pinned: boolean; album: boolean; delete: boolean },
): MessageAction[] | null {
  if (m.pending || m.deleted || m.kind) return null;
  const out: MessageAction[] = [];
  if (can.react) out.push("react");
  if (m.content) out.push("copy");
  if (can.reply) out.push("reply");
  if (can.thread || can.hasThread) out.push("thread");
  if (can.edit) out.push("edit");
  if (can.pin) out.push("pin");
  if (can.album && (m.attachments?.length ?? 0) > 0) out.push("album");
  if (can.delete) out.push("delete");
  return out;
}
