import { describe, expect, it } from "vitest";
import { extension, fileKind } from "./kinds";

describe("fileKind", () => {
  it.each([
    ["image/png", false, "image"], ["application/octet-stream", true, "image"], ["video/webm", false, "video"],
    ["audio/mpeg", false, "audio"], ["audio/wave", false, "audio"],
    ["text/plain; charset=utf-8", false, "document"], ["application/pdf", false, "document"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", false, "document"],
    ["application/vnd.oasis.opendocument.text", false, "document"], ["application/json", false, "document"],
    ["application/zip", false, "archive"], ["application/x-7z-compressed", false, "archive"], ["application/gzip", false, "archive"],
    ["application/octet-stream", false, "other"], ["", false, "other"],
  ] as const)("%s (gif %s) is %s", (ct, gif, kind) => {
    expect(fileKind(ct, gif)).toBe(kind);
  });
});

describe("extension", () => {
  it("is the upper-cased suffix, or FILE", () => {
    expect(extension("notes.v2.PDF")).toBe("PDF");
    expect(extension("Makefile")).toBe("FILE");
  });
});
