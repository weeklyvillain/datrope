import type { FileKind } from "@datrope/core";
import { KIND_ORDER } from "./kinds";

export type GalleryFilter = {
  kind: FileKind | "all";
  channels: string[];
  uploader: string | null;
  q: string;
  view: "tracks" | "playlists"; // only under Music
  playlist: string | null; // an open playlist, under Music → Playlists
  layout: "grid" | "list";
};

export const DEFAULT_FILTER: GalleryFilter = { kind: "all", channels: [], uploader: null, q: "", view: "tracks", playlist: null, layout: "grid" };

export function parseFilter(p: URLSearchParams): GalleryFilter {
  const kind = p.get("kind");
  const view = p.get("view");
  return {
    ...DEFAULT_FILTER,
    kind: KIND_ORDER.includes(kind as FileKind) ? (kind as FileKind) : "all",
    channels: p.getAll("channel"),
    uploader: p.get("uploader"),
    q: p.get("q") ?? "",
    view: view === "playlists" ? "playlists" : "tracks",
    playlist: p.get("playlist"),
  };
}

export function filterParams(f: GalleryFilter): URLSearchParams {
  const p = new URLSearchParams();
  if (f.kind !== "all") p.set("kind", f.kind);
  for (const c of f.channels) p.append("channel", c);
  if (f.uploader) p.set("uploader", f.uploader);
  if (f.q) p.set("q", f.q);
  if (f.view !== "tracks") p.set("view", f.view);
  if (f.playlist) p.set("playlist", f.playlist);
  return p;
}
