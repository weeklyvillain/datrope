const TYPES = ["audio/ogg", "audio/opus", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/wave", ""]; // "": browsers often leave .opus untyped; the server checks the content
const EXTENSIONS = [".ogg", ".opus", ".mp3", ".wav"];
export const MAX_SOUND_BYTES = 512 * 1024;

/** Client-side pre-check of a sound file; returns an error message, or null if it looks usable. The server measures the duration. */
export function checkSoundFile(file: File): string | null {
  const name = file.name.toLowerCase();
  if (!TYPES.includes(file.type) || !EXTENSIONS.some((e) => name.endsWith(e))) return "Use an OGG, MP3 or WAV file";
  if (file.size > MAX_SOUND_BYTES) return "Larger than 512 KB";
  return null;
}
