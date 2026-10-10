import { describe, expect, it } from "vitest";
import { PLATFORMS, describeLink, isBareLink, isHttpsLink } from "./social";

describe("describeLink", () => {
  const cases: [string, string, string][] = [
    ["https://github.com/alice", "GitHub", "github.com"],
    ["https://gitlab.com/alice", "GitLab", "gitlab.com"],
    ["https://youtube.com/@alice", "YouTube", "youtube.com"],
    ["https://youtu.be/abc", "YouTube", "youtu.be"],
    ["https://twitch.tv/alice", "Twitch", "twitch.tv"],
    ["https://steamcommunity.com/id/alice", "Steam", "steamcommunity.com"],
    ["https://x.com/alice", "X", "x.com"],
    ["https://twitter.com/alice", "X", "twitter.com"],
    ["https://bsky.app/profile/alice", "Bluesky", "bsky.app"],
    ["https://instagram.com/alice", "Instagram", "instagram.com"],
    ["https://reddit.com/u/alice", "Reddit", "reddit.com"],
    ["https://open.spotify.com/user/alice", "Spotify", "open.spotify.com"],
    ["https://soundcloud.com/alice", "SoundCloud", "soundcloud.com"],
    ["https://tiktok.com/@alice", "TikTok", "tiktok.com"],
    ["https://linkedin.com/in/alice", "LinkedIn", "linkedin.com"],
    ["https://discord.gg/abc", "Discord", "discord.gg"],
    ["https://discord.com/users/1", "Discord", "discord.com"],
    ["https://kick.com/alice", "Kick", "kick.com"],
    ["https://alice.itch.io", "itch.io", "alice.itch.io"],
    ["https://threads.net/@alice", "Threads", "threads.net"],
    ["https://t.me/alice", "Telegram", "t.me"],
    ["https://ko-fi.com/alice", "Ko-fi", "ko-fi.com"],
  ];
  it.each(cases)("%s is %s", (url, name, host) => {
    expect(describeLink(url)).toMatchObject({ name, host });
  });

  it("matches subdomains and strips nothing from the shown host", () => {
    expect(describeLink("https://www.youtube.com/@alice")).toMatchObject({ name: "YouTube", host: "www.youtube.com" });
  });

  it("does not match a host that only ends with the same letters", () => {
    expect(describeLink("https://notgithub.com/alice")).toMatchObject({ name: "Website", host: "notgithub.com" });
  });

  it("does not match lookalike hosts", () => {
    expect(describeLink("https://github.com.evil.com/x")).toMatchObject({ name: "Website" });
    expect(describeLink("https://evilgithub.com/x")).toMatchObject({ name: "Website" });
  });

  it("shows unknown hosts as Website", () => {
    expect(describeLink("https://alice.example.org/about")).toMatchObject({ name: "Website", host: "alice.example.org" });
  });

  it("recognises Mastodon by an /@ path on any other host", () => {
    expect(describeLink("https://mastodon.social/@alice")).toMatchObject({ name: "Mastodon", host: "mastodon.social" });
    expect(describeLink("https://example.org/about/@alice")).toMatchObject({ name: "Website" });
    // A known site keeps its own name even with an /@ path.
    expect(describeLink("https://tiktok.com/@alice").name).toBe("TikTok");
  });

  it("gives every result an icon name", () => {
    expect(describeLink("https://github.com/a").icon).toBe("github");
    expect(describeLink("https://example.org").icon).toBe("globe");
    expect(describeLink("https://mastodon.social/@a").icon).toBe("mastodon");
  });
});

describe("isHttpsLink", () => {
  it("accepts only https URLs", () => {
    expect(isHttpsLink("https://github.com/alice")).toBe(true);
    expect(isHttpsLink("http://github.com")).toBe(false);
    expect(isHttpsLink("javascript:alert(1)")).toBe(false);
    expect(isHttpsLink("github.com")).toBe(false);
    expect(isHttpsLink("https://u:p@x.com")).toBe(false);
  });
});

describe("PLATFORMS", () => {
  it("starts each known site's link on that site", () => {
    for (const p of PLATFORMS.filter((p) => p.prefix !== "https://")) {
      expect(isHttpsLink(p.prefix + "alice"), p.name).toBe(true);
      expect(describeLink(p.prefix + "alice").name, p.prefix).toBe(p.name);
    }
  });

  it("treats a prefix with nothing filled in as bare", () => {
    expect(isBareLink("https://github.com/")).toBe(true);
    expect(isBareLink("https://")).toBe(true);
    expect(isBareLink("https://github.com/alice")).toBe(false);
  });
});
