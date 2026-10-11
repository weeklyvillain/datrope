import { describe, expect, it } from "vitest";
import { firstPlayer, playerFor } from "./players";

const host = "chat.example.com";

describe("playerFor", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1", "video"],
    ["https://youtu.be/dQw4w9WgXcQ?t=1m30s", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&start=90", "video"],
    ["https://youtube.com/shorts/dQw4w9WgXcQ", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1", "vertical"],
    ["https://www.twitch.tv/somestreamer", "https://player.twitch.tv/?channel=somestreamer&parent=chat.example.com&autoplay=true", "video"],
    ["https://www.twitch.tv/videos/123456", "https://player.twitch.tv/?video=v123456&parent=chat.example.com&autoplay=true", "video"],
    ["https://clips.twitch.tv/FunnyClipSlug-abc", "https://clips.twitch.tv/embed?clip=FunnyClipSlug-abc&parent=chat.example.com&autoplay=true", "video"],
    ["https://www.twitch.tv/somestreamer/clip/Slug_1", "https://clips.twitch.tv/embed?clip=Slug_1&parent=chat.example.com&autoplay=true", "video"],
    ["https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT", "https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT", 152],
    ["https://open.spotify.com/intl-sv/album/4cOdK2wGLETKBW3PvgPWqT?si=x", "https://open.spotify.com/embed/album/4cOdK2wGLETKBW3PvgPWqT", 352],
  ])("%s", (url, src, shape) => {
    expect(playerFor(url, host)).toMatchObject({ src, shape });
  });

  it("has a thumbnail for YouTube only", () => {
    expect(playerFor("https://youtu.be/dQw4w9WgXcQ", host)?.thumbnail).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
    expect(playerFor("https://www.twitch.tv/somestreamer", host)?.thumbnail).toBeUndefined();
  });

  it.each([
    "http://www.youtube.com/watch?v=dQw4w9WgXcQ", // not https
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/@channel",
    "https://www.twitch.tv/directory",
    "https://www.twitch.tv/",
    "https://open.spotify.com/user/someone",
    "https://example.com/watch?v=dQw4w9WgXcQ",
  ])("ignores %s", (url) => {
    expect(playerFor(url, host)).toBeUndefined();
  });
});

describe("firstPlayer", () => {
  it("finds the first playable link outside code and drops trailing punctuation", () => {
    const found = firstPlayer("see `https://youtu.be/aaaaaaaaaaa` and https://example.com then https://youtu.be/dQw4w9WgXcQ!", host);
    expect(found?.url).toBe("https://youtu.be/dQw4w9WgXcQ");
    expect(firstPlayer("nothing here", host)).toBeUndefined();
  });
});
