import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { playerFor } from "@/lib/players";
import { InlinePlayer } from "./InlinePlayer";

const url = "https://youtu.be/dQw4w9WgXcQ";

describe("InlinePlayer", () => {
  it("shows a YouTube video's thumbnail, title and channel, but not the player", () => {
    const html = renderToStaticMarkup(<InlinePlayer player={playerFor(url, "x")!} url={url}
      embed={{ url, site: "YouTube", title: "Never Gonna Give You Up", description: "", author: "Rick Astley" }} />);
    expect(html).toContain('src="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"');
    expect(html).toContain("Never Gonna Give You Up");
    expect(html).toContain("Rick Astley");
    expect(html).toContain('aria-label="Play video from YouTube"');
    expect(html).not.toContain("<iframe");
  });

  it("keeps the compact card for links without a thumbnail", () => {
    const html = renderToStaticMarkup(<InlinePlayer player={playerFor("https://www.twitch.tv/somestreamer", "x")!} url="https://www.twitch.tv/somestreamer" />);
    expect(html).not.toContain("<img");
    expect(html).toContain('aria-label="Play live stream from Twitch"');
  });
});
