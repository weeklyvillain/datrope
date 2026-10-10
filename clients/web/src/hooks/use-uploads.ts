import type { Attachment } from "@datrope/core";
import { useState } from "react";
import { client, errorText, formatBytes, instanceInfo } from "@/session";

export const MAX_FILES = 10; // the server's limit per message

export interface PendingFile {
  key: string;
  name: string;
  size: number;
  type: string;
  attachment?: Attachment; // set once uploaded
  error?: string;
}

/** Files being attached to a message in `channelId`: each starts uploading as it is added.
 *  `onError` gets a message when files are refused (too many, or not matching `accept`). */
export function useUploads(channelId: string, { onError, accept }: {
  onError: (message: string) => void;
  accept?: { test: (file: File) => boolean; message: string };
}) {
  const [files, setFiles] = useState<PendingFile[]>([]);

  const update = (key: string, patch: Partial<PendingFile>) =>
    setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  const add = (list: File[]) => {
    const refused = !!accept && list.some((f) => !accept.test(f));
    if (accept) list = list.filter((f) => accept.test(f));
    const room = MAX_FILES - files.length;
    const tooMany = list.length > room;
    // Both problems at once are reported together, so neither hides the other.
    if (refused || tooMany) {
      onError([refused && accept?.message, tooMany && `You can attach up to ${MAX_FILES} files`].filter(Boolean).join(" "));
    }
    for (const file of list.slice(0, Math.max(0, room))) {
      const key = crypto.randomUUID();
      setFiles((fs) => [...fs, { key, name: file.name, size: file.size, type: file.type }]);
      void (async () => {
        try {
          const { max_upload_bytes: max } = await instanceInfo();
          if (file.size > max) {
            update(key, { error: `Over the ${formatBytes(max)} limit` });
            return;
          }
          update(key, { attachment: await client.upload(channelId, file, file.name) });
        } catch (e) {
          update(key, { error: errorText(e) });
        }
      })();
    }
  };

  return {
    files,
    add,
    remove: (key: string) => setFiles((fs) => fs.filter((f) => f.key !== key)),
    clear: () => setFiles([]),
    uploading: files.some((f) => !f.attachment && !f.error),
    ready: files.flatMap((f) => (f.attachment ? [f.attachment] : [])),
  };
}
