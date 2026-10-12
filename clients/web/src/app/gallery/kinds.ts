import type { FileKind } from "@datrope/core";

export const KIND_ORDER: FileKind[] = ["image", "video", "audio", "document", "archive", "other"];
export const KIND_LABELS: Record<FileKind, string> = {
  image: "Photos", video: "Videos", audio: "Music", document: "Documents", archive: "Archives", other: "Other",
};
export const KIND_SINGULAR: Record<FileKind, string> = {
  image: "Photo", video: "Video", audio: "Track", document: "File", archive: "File", other: "File",
};

const DOCUMENTS = new Set(["application/pdf", "application/json", "application/rtf", "application/msword",
  "application/vnd.ms-excel", "application/vnd.ms-powerpoint"]);
const ARCHIVES = new Set(["application/zip", "application/x-7z-compressed", "application/x-rar-compressed", "application/vnd.rar",
  "application/x-tar", "application/gzip", "application/x-gzip", "application/x-bzip2", "application/x-xz"]);

/** A file's kind from its sniffed type. Mirrors kindSQL in server/internal/messages/files.go: change both together. */
export function fileKind(contentType: string, gif = false): FileKind {
  const ct = contentType.split(";")[0].trim().toLowerCase();
  if (gif || ct.startsWith("image/")) return "image";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("text/") || DOCUMENTS.has(ct) || ct.startsWith("application/vnd.openxmlformats-officedocument.")
    || ct.startsWith("application/vnd.oasis.opendocument.")) return "document";
  if (ARCHIVES.has(ct)) return "archive";
  return "other";
}

/** "notes.pdf" → "PDF"; no extension → "FILE". */
export function extension(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i > 0 && i < filename.length - 1 ? filename.slice(i + 1).toUpperCase() : "FILE";
}
