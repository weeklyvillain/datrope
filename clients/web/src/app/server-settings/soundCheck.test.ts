import { describe, expect, it } from "vitest";
import { checkSoundFile } from "./soundCheck";

const file = (name: string, type: string, size: number) => new File([new Uint8Array(size)], name, { type });

describe("checkSoundFile", () => {
  it("accepts a small wav", () => expect(checkSoundFile(file("a.wav", "audio/wav", 1024))).toBeNull());
  it("accepts .ogg and .opus", () => {
    expect(checkSoundFile(file("a.ogg", "audio/ogg", 10))).toBeNull();
    expect(checkSoundFile(file("a.opus", "audio/ogg", 10))).toBeNull();
  });
  it("rejects other types", () => expect(checkSoundFile(file("a.txt", "text/plain", 10))).toBe("Use an OGG, MP3 or WAV file"));
  it("rejects a good type with a bad extension", () => expect(checkSoundFile(file("a.flac", "audio/wav", 10))).toBe("Use an OGG, MP3 or WAV file"));
  it("rejects files over 512 KB", () => {
    expect(checkSoundFile(file("a.mp3", "audio/mpeg", 600 * 1024))).toBe("Larger than 512 KB");
    expect(checkSoundFile(file("a.mp3", "audio/mpeg", 512 * 1024))).toBeNull();
  });
});
