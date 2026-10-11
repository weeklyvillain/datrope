import type { Attachment } from "@datrope/core";
import { useRef, useState } from "react";
import { client, errorText, formatBytes, instanceInfo } from "@/session";

export const MAX_FILES = 10; // the server's limit per message

export interface PendingFile {
  key: string;
  name: string;
  size: number;
  type: string;
  text?: string; // a pasted snippet's text, so it can be renamed or pasted back
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
  // The latest upload per file: a rename starts a new one, and the older result is dropped.
  const runs = useRef(new Map<string, string>());

  const update = (key: string, patch: Partial<PendingFile>) =>
    setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  const upload = (key: string, file: File) => {
    const run = crypto.randomUUID();
    runs.current.set(key, run);
    const current = () => runs.current.get(key) === run;
    void (async () => {
      try {
        const { max_upload_bytes: max } = await instanceInfo();
        if (file.size > max) {
          if (current()) update(key, { error: `Over the ${formatBytes(max)} limit` });
          return;
        }
        const attachment = await client.upload(channelId, file, file.name);
        if (current()) update(key, { attachment });
      } catch (e) {
        if (current()) update(key, { error: errorText(e) });
      }
    })();
  };

  const add = (list: File[], text?: string) => {
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
      setFiles((fs) => [...fs, { key, name: file.name, size: file.size, type: file.type, text }]);
      upload(key, file);
    }
  };

  return {
    files,
    add: (list: File[]) => add(list),
    /** Attaches pasted text as a file named `name`. */
    addText: (text: string, name: string) => add([new File([text], name, { type: "text/plain" })], text),
    /** Renames a pasted snippet by uploading its text again under the new name. */
    rename: (key: string, name: string) => {
      const f = files.find((x) => x.key === key);
      if (f?.text === undefined || name === f.name) return;
      update(key, { name, attachment: undefined, error: undefined });
      upload(key, new File([f.text], name, { type: "text/plain" }));
    },
    remove: (key: string) => {
      runs.current.delete(key);
      setFiles((fs) => fs.filter((f) => f.key !== key));
    },
    clear: () => {
      runs.current.clear();
      setFiles([]);
    },
    uploading: files.some((f) => !f.attachment && !f.error),
    ready: files.flatMap((f) => (f.attachment ? [f.attachment] : [])),
  };
}
