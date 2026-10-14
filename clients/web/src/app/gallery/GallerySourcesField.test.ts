import { describe, expect, it, vi } from "vitest";
vi.mock("../../session", () => ({ useApp: () => undefined }));
import { sourcesBody } from "./GallerySourcesField";

describe("sourcesBody", () => {
  it("sends ids only for picked channels", () => {
    expect(sourcesBody({ mode: "all", ids: ["a"] })).toEqual({ gallery_sources: "all" });
    expect(sourcesBody({ mode: "selected", ids: ["a", "b"] })).toEqual({ gallery_sources: "selected", source_channel_ids: ["a", "b"] });
  });
});
