import type { Attachment } from "@datrope/core";
import { client } from "@/session";
import { fitBox } from "./media";

const CLASS = "block h-auto max-w-full rounded-lg border bg-card";

/** A GIF posted with /gif: it plays muted and looped with no controls, like an image.
 *  Most are MP4s; a WebP or GIF file shows as an image. */
export function GifMedia({ attachment: a }: { attachment: Attachment }) {
  const src = client.url(a.url);
  const size = a.width && a.height ? fitBox(a.width, a.height) : undefined;
  if (a.content_type.startsWith("video/")) {
    return (
      <video className={CLASS} src={src} width={size?.width} height={size?.height} aria-label={a.filename}
        autoPlay loop muted playsInline disablePictureInPicture />
    );
  }
  return <img className={CLASS} src={src} width={size?.width} height={size?.height} alt={a.filename} loading="lazy" />;
}
