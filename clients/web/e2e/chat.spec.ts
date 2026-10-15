import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

// A 1x1 PNG.
const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
// A custom emoji image (a 1x1 PNG); its name comes from the file name.
const PARROT_PNG = fileURLToPath(new URL("./fixtures/parrot.png", import.meta.url));
// The Ocean palette's accent (#4aa3ff) as getComputedStyle reports it.
const OCEAN = "rgb(74, 163, 255)";

// Stands in for YouTube's IFrame API in the watch-together step: no network, and playback is just a clock.
const FAKE_YT = `window.YT = { Player: class {
  constructor(el, o) { this.t = o.playerVars.start || 0; this.s = -1; this.at = 0; el.dataset.fakeYt = o.videoId; setTimeout(() => o.events.onReady({ target: this }), 0); }
  time() { return this.s === 1 ? this.t + (Date.now() - this.at) / 1000 : this.t; }
  playVideo() { if (this.s !== 1) { this.at = Date.now(); this.s = 1; } }
  pauseVideo() { this.t = this.time(); this.s = 2; }
  seekTo(t) { this.t = t; this.at = Date.now(); }
  getCurrentTime() { return this.time(); } getPlayerState() { return this.s; } getDuration() { return 600; }
  setVolume() {} mute() {} unMute() {} destroy() {}
} }; window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady();`;

// A solid-colour RGB PNG of the given size (for the banner upload).
function solidPng(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x66)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// A silent 0.5 s mono 16-bit 8 kHz WAV: the server measures the length from the file.
function silentWav(): Buffer {
  const samples = 4000;
  const data = samples * 2;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(data, 40);
  return b;
}

// Runs against a fresh instance: the first account owns the server.
test.beforeAll(async ({ request }) => {
  await expect(async () => {
    expect((await request.get("/api/instance")).ok()).toBe(true);
  }).toPass({ timeout: 60_000 });
});

async function register(page: Page, username: string) {
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Create account" }).click();
}

async function openServerSettings(page: Page) {
  await page.getByRole("button", { name: "Datrope menu" }).click();
  await page.getByRole("menuitem", { name: "Server settings" }).click();
}

async function send(page: Page, text: string) {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByLabel("Message", { exact: true }).press("Enter");
}

test("the owner sets up the server, a friend joins by invite, accepts the rules, and they chat", async ({ browser, request }) => {
  // 1. alice registers first, owns the server, and lands in #general.
  const alice = await (await browser.newContext()).newPage();
  await alice.goto("/register");
  await expect(alice.getByRole("heading", { name: "Create the admin account" })).toBeVisible();
  await register(alice, "alice");
  await expect(alice.getByRole("heading", { name: "# general" })).toBeVisible();
  await expect(alice.getByRole("button", { name: "Datrope menu" })).toContainText("Datrope");
  await expect(alice.getByRole("tab", { name: "Channels" })).toBeVisible();
  await expect(alice.getByRole("tab", { name: "Messages" })).toBeVisible();

  // 2. Server settings → Look: Ocean recolours the primary buttons.
  await openServerSettings(alice);
  await alice.getByRole("link", { name: "Look" }).click();
  await alice.getByRole("radio", { name: "Ocean" }).click();
  await expect(alice.getByRole("radio", { name: "Ocean" })).toBeChecked();
  await alice.getByRole("link", { name: "Invites" }).click();
  const createInvite = alice.getByRole("button", { name: "Create invite" });
  await expect.poll(() => createInvite.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(OCEAN);

  // 3. The welcome page gets rules and the rules gate.
  await alice.getByRole("link", { name: "Welcome page" }).click();
  await alice.getByLabel("Welcome page in Markdown").fill("# Rules\n\nBe nice.");
  await alice.getByRole("checkbox", { name: "Require new members to accept the rules" }).click();
  await alice.getByRole("button", { name: "Save page" }).click();
  const page = alice.getByRole("main", { name: "welcome" });
  await expect(page.getByRole("button", { name: "Edit page" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Rules" })).toBeVisible();
  await expect(page.getByText("Be nice.", { exact: true })).toBeVisible();

  // 4. An invite from Server settings → Invites.
  await openServerSettings(alice);
  await alice.getByRole("link", { name: "Invites" }).click();
  await alice.getByRole("button", { name: "Create invite" }).click();
  const link = alice.getByLabel("New invite link");
  await expect(link).toHaveValue(/\/invite\//);
  const inviteUrl = await link.inputValue();
  await alice.getByRole("button", { name: /Back to chat/ }).click();
  await alice.getByRole("link", { name: "general" }).click();
  await expect(alice.getByRole("heading", { name: "# general" })).toBeVisible();

  // 5. bob registers with the invite and sees only the welcome page until he accepts the rules.
  const bob = await (await browser.newContext()).newPage();
  await bob.goto(inviteUrl);
  await expect(bob.getByRole("heading", { name: "Join Datrope" })).toBeVisible();
  await bob.getByRole("link", { name: "Create account" }).click();
  await register(bob, "bob");
  await expect(bob.getByRole("heading", { name: "Rules" })).toBeVisible();
  await expect(bob.getByText("Be nice.", { exact: true })).toBeVisible();
  await expect(bob.getByRole("link", { name: "general" })).toHaveCount(0);
  await expect(bob.getByRole("tab", { name: "Messages" })).toBeDisabled();
  await bob.getByRole("button", { name: "I accept the rules" }).click();
  await expect(bob.getByRole("heading", { name: "# general" })).toBeVisible();

  // 6. bob says hello; alice sees it. Typing is shown.
  await send(bob, "hello alice");
  await expect(alice.getByText("hello alice")).toBeVisible();

  // bob just sent, so his typing is throttled for a few seconds; alice types instead.
  await alice.getByLabel("Message", { exact: true }).pressSequentially("hi b");
  await expect(bob.getByText("alice is typing…")).toBeVisible();
  await alice.getByLabel("Message", { exact: true }).pressSequentially("ob");
  await alice.getByLabel("Message", { exact: true }).press("Enter");
  await expect(bob.getByText("hi bob")).toBeVisible();

  // Command palette: Ctrl+K opens a DM with bob, then jumps back to #general.
  const palette = alice.getByRole("combobox", { name: "Command palette" });
  await alice.keyboard.press("Control+k");
  await palette.fill("bob");
  await palette.press("Enter");
  await expect(alice).toHaveURL(/\/messages\/\d+/);
  await alice.keyboard.press("Control+k");
  await palette.fill("general");
  await palette.press("Enter");
  await expect(alice.getByRole("heading", { name: "# general" })).toBeVisible();

  // Files: alice attaches an image; bob sees it in the channel.
  await alice.locator('input[type="file"]').setInputFiles({
    name: "pixel.png", mimeType: "image/png", buffer: Buffer.from(PIXEL_PNG, "base64"),
  });
  await expect(alice.getByText("pixel.png")).toBeVisible();
  await alice.getByLabel("Message", { exact: true }).fill("a picture");
  await alice.getByRole("button", { name: "Send" }).click();
  await expect(bob.getByText("a picture")).toBeVisible();
  const img = bob.getByRole("img", { name: "pixel.png" });
  await expect(img).toBeVisible();
  // Visible alt text is not enough: the image must actually load, with the server's download headers intact through Caddy.
  await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth)).toBeGreaterThan(0);
  const src = new URL((await img.getAttribute("src"))!, bob.url()).toString();
  const res = await bob.request.get(src);
  expect(res.status()).toBe(200);
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["content-security-policy"]).toContain("sandbox");

  await alice.reload();
  await expect(alice.getByText("hello alice")).toBeVisible();
  await expect(alice.getByText("hi bob")).toBeVisible();

  // Custom emoji: alice uploads parrot.png from Server settings → Emoji, keeping the name "parrot".
  await openServerSettings(alice);
  await alice.getByRole("link", { name: "Emoji" }).click();
  await alice.getByLabel("Choose emoji images").setInputFiles(PARROT_PNG);
  await expect(alice.getByLabel("Name for emoji 1")).toHaveValue("parrot");
  await alice.getByRole("button", { name: "Add all" }).click();
  await expect(alice.getByRole("region", { name: "Server emoji" }).getByLabel("Rename :parrot:")).toHaveValue("parrot");
  await alice.getByRole("button", { name: /Back to chat/ }).click();
  await alice.getByRole("link", { name: "general" }).click();
  await expect(alice.getByRole("heading", { name: "# general" })).toBeVisible();

  // Soundboard: alice adds "Boop" (a silent 0.5 s WAV) with a bell emoji from Server settings, Soundboard.
  await openServerSettings(alice);
  await alice.getByRole("link", { name: "Soundboard" }).click();
  await alice.getByLabel("Choose a sound file").setInputFiles({ name: "Boop.wav", mimeType: "audio/wav", buffer: silentWav() });
  await expect(alice.getByLabel("Sound name")).toHaveValue("Boop");
  await alice.getByRole("button", { name: "Sound emoji" }).click();
  await alice.getByLabel("Search emoji").fill("bell");
  await alice.getByRole("button", { name: /^bell$/i }).first().click();
  await expect(alice.getByRole("button", { name: "Sound emoji" })).toHaveText("\u{1F514}");
  await alice.getByRole("button", { name: "Add sound" }).click();
  const serverSounds = alice.getByRole("region", { name: "Server sounds" });
  await expect(serverSounds.getByLabel("Rename Boop")).toHaveValue("Boop");
  await expect(serverSounds.getByText("0.5 s")).toBeVisible();
  await alice.getByRole("button", { name: /Back to chat/ }).click();
  await alice.getByRole("link", { name: "general" }).click();
  await expect(alice.getByRole("heading", { name: "# general" })).toBeVisible();

  // Mentions: bob sees alice's message highlighted, with @bob as a mention.
  // Typing @bo opens the member suggestions: Enter completes the mention, the next Enter sends.
  await alice.getByLabel("Message", { exact: true }).fill("who wants pizza? @bo");
  await expect(alice.getByRole("listbox", { name: "Member suggestions" }).getByRole("option", { name: /bob/ })).toBeVisible();
  await alice.getByLabel("Message", { exact: true }).press("Enter");
  await expect(alice.getByLabel("Message", { exact: true })).toHaveValue("who wants pizza? @bob ");
  await alice.getByLabel("Message", { exact: true }).press("Enter");
  const pizzaForBob = bob.getByRole("article").filter({ hasText: "who wants pizza?" }).first(); // the reply quotes it too
  await expect(pizzaForBob).toHaveClass(/border-primary/);
  await expect(pizzaForBob.locator(".mention[data-me]")).toHaveText("@bob");

  // Replies: bob replies from the hover toolbar; alice sees the quote line, and it jumps to the original.
  await pizzaForBob.hover();
  await pizzaForBob.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(bob.getByText("Replying to alice")).toBeVisible();
  await send(bob, "me!");
  await expect(bob.getByText("Replying to alice")).toHaveCount(0);
  const reply = alice.getByRole("article").filter({ hasText: "me!" });
  const quote = reply.getByRole("button", { name: /alice\s*who wants pizza\?/ });
  await expect(quote).toBeVisible();
  const pizza = alice.getByRole("article").filter({ hasText: "who wants pizza?" }).first();
  await quote.click();
  await expect(pizza).toHaveClass(/message-flash/);
  await expect(pizza).toBeInViewport();

  // Reactions: bob reacts with :parrot:; alice adds hers to the same pill.
  await pizzaForBob.hover();
  await pizzaForBob.getByRole("button", { name: "Add reaction", exact: true }).click();
  await bob.getByLabel("Search emoji").fill("parrot");
  await bob.getByRole("button", { name: ":parrot:", exact: true }).click();
  const one = pizza.getByRole("button", { name: ":parrot:, 1 person", exact: true });
  await expect(one).toHaveAttribute("aria-pressed", "false");
  await one.click();
  await expect(pizza.getByRole("button", { name: ":parrot:, 2 people including you", exact: true })).toHaveAttribute("aria-pressed", "true");

  // Markdown: bold renders as <strong>, and the spoiler stays hidden until clicked.
  await send(alice, "**bold** and ||spoiler||");
  const md = bob.getByRole("article").filter({ hasText: "bold and" });
  await expect(md.locator(".chat-md strong")).toHaveText("bold");
  const spoiler = md.getByRole("button", { name: "Spoiler, select to show" });
  await expect(spoiler).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => spoiler.evaluate((e) => getComputedStyle(e).color)).toBe("rgba(0, 0, 0, 0)");
  await spoiler.click();
  const shown = md.getByRole("button", { name: "spoiler", exact: true });
  await expect(shown).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => shown.evaluate((e) => getComputedStyle(e).color)).not.toBe("rgba(0, 0, 0, 0)");

  // Slash commands: the picker completes /shrug, and the face arrives with its backslash.
  const box = alice.getByLabel("Message", { exact: true });
  await box.fill("/shr");
  await expect(alice.getByRole("listbox", { name: "Command suggestions" }).getByRole("option", { name: /^\/shrug/ })).toBeVisible();
  await box.press("Tab");
  await expect(box).toHaveValue("/shrug ");
  await box.pressSequentially("hi");
  await box.press("Enter");
  await expect(bob.getByRole("article").filter({ hasText: "hi ¯\\_(ツ)_/¯" })).toBeVisible();
  await expect(box).toHaveValue("");

  // /wheel: the reel spins for both and lands on one of the options.
  await send(alice, "/wheel Pizza, Sushi, Tacos");
  for (const page of [alice, bob]) {
    const spin = page.getByRole("region", { name: "Wheel spin" }).last();
    await expect(spin).toContainText(/Landed on(Pizza|Sushi|Tacos)$/, { timeout: 10_000 });
  }

  // An unknown command is not sent, and the text stays for fixing.
  await send(alice, "/nope");
  await expect(alice.getByRole("alert").filter({ hasText: "Unknown command /nope" })).toBeVisible();
  await expect(box).toHaveValue("/nope");
  await box.fill("");

  // /gif: hidden until an admin adds a Klipy key in Server settings → Integrations. Tests never
  // reach Klipy: the GIF endpoints are stubbed, and "attach" uploads a real image so the message can claim it.
  await send(alice, "/gif cat");
  await expect(alice.getByRole("alert").filter({ hasText: "Unknown command /gif" })).toBeVisible();
  await box.fill("");
  await openServerSettings(alice);
  await alice.getByRole("link", { name: "Integrations" }).click();
  await expect(alice.getByText("No key is set, so /gif is hidden.")).toBeVisible();
  await alice.getByLabel("Klipy API key").fill("e2e-not-a-real-key");
  await alice.getByRole("button", { name: "Save key" }).click();
  await expect(alice.getByText("A Klipy API key is set. /gif is available.")).toBeVisible();
  await expect(alice.getByLabel("Klipy API key")).toHaveValue("");
  await alice.getByRole("button", { name: /Back to chat/ }).click();
  await alice.getByRole("link", { name: "general" }).click();

  const cat = { id: "cat-1", title: "Cat", preview_url: `data:image/png;base64,${PIXEL_PNG}`, width: 100, height: 80 };
  const searches: string[] = [];
  await alice.route(/\/api\/gifs\/(trending|search)/, (route) => {
    searches.push(new URL(route.request().url()).searchParams.get("q") ?? "");
    return route.fulfill({ json: { items: [cat] } });
  });
  await alice.route(/\/api\/gifs\/[^/]+\/attach/, async (route) => {
    const channelId = new URL(route.request().url()).searchParams.get("channel_id")!;
    const res = await alice.request.post(`/api/attachments?channel_id=${channelId}`, {
      headers: { "X-Datrope-CSRF": "1" },
      multipart: { file: { name: "cat.png", mimeType: "image/png", buffer: Buffer.from(PIXEL_PNG, "base64") } },
    });
    expect(res.status()).toBe(201);
    await route.fulfill({ status: 201, json: { ...(await res.json()), gif: true } });
  });

  // The picker offers /gif once the instance info says GIFs are on.
  await box.fill("/gi");
  await expect(alice.getByRole("listbox", { name: "Command suggestions" }).getByRole("option", { name: /^\/gif/ })).toBeVisible();
  await box.fill("/gif cat");
  await box.press("Enter");
  const gifDialog = alice.getByRole("dialog", { name: "Send a GIF" });
  await expect(gifDialog.getByLabel("Search GIFs")).toHaveValue("cat");
  await expect(gifDialog.getByText("Powered by KLIPY")).toBeVisible();
  await gifDialog.getByRole("button", { name: "Cat" }).click();
  await gifDialog.getByLabel("Caption").fill("so cute");
  await gifDialog.getByRole("button", { name: "Send" }).click();
  await expect(gifDialog).toBeHidden();
  await expect(bob.getByRole("article").filter({ hasText: "so cute" }).getByRole("img", { name: "cat.png" })).toBeVisible();
  expect(searches).toContain("cat");

  // Polls: alice creates one with /poll; bob votes and alice's count changes live; alice sees who voted, then ends it.
  await box.fill("/poll Pizza or tacos?");
  await box.press("Enter");
  const pollDialog = alice.getByRole("dialog", { name: "Create a poll" });
  await expect(pollDialog.getByLabel("Question")).toHaveValue("Pizza or tacos?");
  await pollDialog.getByLabel("Answer 1", { exact: true }).fill("Pizza");
  await pollDialog.getByLabel("Answer 2", { exact: true }).fill("Tacos");
  await expect(pollDialog.getByLabel("Duration")).toHaveValue("24h");
  await pollDialog.getByRole("button", { name: "Post poll" }).click();
  await expect(pollDialog).toBeHidden();

  const pollForAlice = alice.getByRole("region", { name: "Poll: Pizza or tacos?" });
  const pollForBob = bob.getByRole("region", { name: "Poll: Pizza or tacos?" });
  await expect(pollForAlice.getByText(/^0 votes · ends in/)).toBeVisible();
  await pollForBob.getByRole("button", { name: "Pizza, 0%" }).click();
  await expect(pollForBob.getByRole("button", { name: "Pizza, 100%" })).toHaveAttribute("aria-pressed", "true");
  await expect(pollForAlice.getByText(/^1 vote · ends in/)).toBeVisible();
  await expect(pollForAlice.getByRole("button", { name: "Pizza, 100%" })).toHaveAttribute("aria-pressed", "false");

  await pollForAlice.getByRole("button", { name: "Voters for Pizza, 1" }).click();
  await expect(alice.getByRole("dialog").getByText("bob", { exact: true })).toBeVisible();
  await alice.keyboard.press("Escape");

  await pollForAlice.getByRole("button", { name: "End poll" }).click();
  await expect(pollForBob.getByText("1 vote · Final results")).toBeVisible();
  await expect(pollForBob.getByRole("button", { name: "Tacos, 0%" })).toBeDisabled();

  // 7. bob starts a DM with alice from the Messages tab; alice sees the unread dot and the message.
  await bob.getByRole("tab", { name: "Messages" }).click();
  await bob.getByRole("button", { name: "New message" }).click();
  await bob.getByRole("checkbox", { name: /alice/ }).click();
  await bob.getByRole("button", { name: "Start conversation" }).click();
  await expect(bob.getByRole("heading", { name: "alice" })).toBeVisible();
  await send(bob, "psst");
  await expect(bob.getByText("psst")).toBeVisible();

  await expect(alice.getByRole("tab", { name: "Messages (unread)" })).toBeVisible();
  await alice.getByRole("tab", { name: "Messages (unread)" }).click();
  await alice.getByRole("link", { name: /bob/ }).click();
  await expect(alice.getByRole("heading", { name: "bob" })).toBeVisible();
  await expect(alice.getByText("psst")).toBeVisible();
  await expect(alice.getByRole("tab", { name: "Messages", exact: true })).toBeVisible();

  // Voice: alice creates a voice channel and joins, bob joins by clicking it, each sees the other, and leaving is noticed.
  await alice.getByRole("tab", { name: "Channels" }).click();
  await alice.getByRole("button", { name: "Datrope menu" }).click();
  await alice.getByRole("menuitem", { name: "Create channel" }).click();
  await alice.getByRole("radio", { name: "Voice" }).click();
  await alice.getByLabel("Name").fill("Lounge");
  await alice.getByRole("button", { name: "Create", exact: true }).click();
  await expect(alice.getByRole("main", { name: "Lounge" })).toBeVisible();
  await alice.getByRole("button", { name: "Join voice" }).click();
  await expect(alice.getByRole("status").filter({ hasText: "Voice connected" })).toBeVisible();
  const lounge = alice.getByRole("list", { name: "In voice: Lounge" });
  await expect(lounge.getByText("alice")).toBeVisible(); // reported by LiveKit's webhook

  await bob.getByRole("tab", { name: "Channels" }).click();
  await bob.getByRole("link", { name: "Lounge" }).first().click(); // clicking a voice channel joins it
  await expect(bob.getByRole("status").filter({ hasText: "Voice connected" })).toBeVisible();
  await expect(lounge.getByText("bob")).toBeVisible();
  await expect(alice.getByRole("button", { name: /^Connection quality: / })).toBeVisible();

  // Going live (from the call controls under the tiles): alice picks Detail in the Go Live dialog; bob watches;
  // changing the source keeps bob watching.
  const aliceControls = alice.getByRole("toolbar", { name: "Call controls" });
  await aliceControls.getByRole("button", { name: "Share screen" }).click();
  const goLive = alice.getByRole("dialog", { name: "Go Live" });
  await goLive.getByRole("radio", { name: /Detail/ }).click();
  await goLive.getByRole("switch", { name: "Share audio" }).click(); // the fake screen has no audio
  await goLive.getByRole("button", { name: "Go Live" }).click();
  const aliceMain = alice.getByRole("main", { name: "Lounge" });
  await expect(aliceMain.getByText("alice's screen", { exact: true })).toBeVisible();
  const bobLounge = bob.getByRole("main", { name: "Lounge" });
  await bobLounge.getByRole("button", { name: "Watch", exact: true }).click();
  await expect(bobLounge.getByText("alice's screen", { exact: true })).toBeVisible();
  await expect(bobLounge.getByText("Loading alice's screen...")).toHaveCount(0); // the video arrived
  // The local capture's MediaStreamTrack id changes on a swap; the LiveKit publication (and bob's subscription) stays.
  const captureId = () => alice.evaluate(() => [...document.querySelectorAll<HTMLVideoElement>("main video")]
    .map((v) => (v.srcObject as MediaStream | null)?.getVideoTracks()[0]?.id).join());
  const before = await captureId();
  await aliceControls.getByRole("button", { name: "Share screen" }).click();
  const menu = alice.getByRole("group", { name: "Stream settings" });
  await menu.getByRole("button", { name: "Change source" }).click();
  await expect.poll(captureId).not.toBe(before);
  await expect(bobLounge.getByText("alice's screen", { exact: true })).toBeVisible();
  await expect(bobLounge.getByText("Loading alice's screen...")).toHaveCount(0);
  await expect(alice.getByRole("alert")).toHaveCount(0);
  // The pressed Share screen button toggles the menu.
  const shareButton = aliceControls.getByRole("button", { name: "Share screen" });
  await expect(shareButton).toHaveAttribute("aria-expanded", "true");
  await shareButton.click();
  await expect(menu).toHaveCount(0);
  await expect(shareButton).toHaveAttribute("aria-expanded", "false");
  await shareButton.click();
  await menu.getByRole("button", { name: "Stop streaming" }).click();
  await expect(aliceMain.getByText("alice's screen", { exact: true })).toHaveCount(0);
  await expect(bobLounge.getByText("alice's screen", { exact: true })).toHaveCount(0);

  // Watch together: alice starts a YouTube video from the call controls; it takes bob's stage and shows in the sidebar;
  // bob pauses and alice is told; alice stops it for everyone.
  for (const p of [alice, bob]) {
    await p.route("https://www.youtube.com/iframe_api", (r) => r.fulfill({ contentType: "text/javascript", body: FAKE_YT }));
  }
  await aliceControls.getByRole("button", { name: "Watch together" }).click();
  const watchDialog = alice.getByRole("dialog", { name: "Watch together" });
  await watchDialog.getByLabel("Video link").fill("https://example.com/not-a-video");
  await watchDialog.getByRole("button", { name: "Start watching" }).click();
  await expect(watchDialog.getByRole("alert")).toContainText("paste a YouTube video");
  await watchDialog.getByLabel("Video link").fill("https://youtu.be/dQw4w9WgXcQ");
  await watchDialog.getByRole("button", { name: "Start watching" }).click();
  await expect(watchDialog).toHaveCount(0);
  const bobWatch = bobLounge.getByRole("region", { name: "Watch together" });
  await expect(bobWatch).toBeVisible();
  await expect(bob.getByRole("list", { name: "In voice: Lounge" }).getByText(/^Watching · /)).toBeVisible();
  await bobWatch.hover();
  await bobWatch.getByRole("button", { name: "Pause" }).click();
  const aliceWatch = aliceMain.getByRole("region", { name: "Watch together" });
  await expect(aliceWatch.getByRole("status")).toHaveText("bob paused");
  await expect(aliceWatch.getByRole("button", { name: "Play" })).toBeVisible(); // paused: the controls stay up
  await aliceWatch.getByRole("button", { name: "Stop" }).click();
  await expect(bobWatch).toHaveCount(0);
  await expect(bob.getByRole("list", { name: "In voice: Lounge" }).getByText(/^Watching · /)).toHaveCount(0);

  // Soundboard: alice plays Boop; bob sees the chip on alice's tile.
  await aliceControls.getByRole("button", { name: "Soundboard" }).click();
  await alice.getByRole("dialog", { name: "Soundboard" }).getByRole("button", { name: "Play Boop, 0.5 s" }).click();
  const bobMain = bob.getByRole("main", { name: "Lounge" });
  await expect(bobMain.getByRole("status").filter({ hasText: "Boop" })).toContainText("\u{1F514}");

  // Per-person volume: bob turns alice up to 150 % just for himself; her tile shows the badge.
  await bobMain.getByRole("button", { name: "More options for alice" }).first().click({ force: true });
  await bob.getByRole("slider", { name: "Volume for alice, just for you" }).fill("150");
  await expect(bobMain.getByRole("img", { name: "Volume changed" }).first()).toBeVisible();
  await bob.keyboard.press("Escape");

  await bob.getByRole("region", { name: "You" }).getByRole("button", { name: "Mute" }).click();
  await expect(lounge.getByRole("img", { name: "Muted" })).toBeVisible();

  // Moving: alice creates a second voice channel by right-clicking the channel list, then drags bob onto it.
  const channelList = alice.getByRole("tabpanel", { name: "Channels" });
  const listBox = (await channelList.boundingBox())!;
  await channelList.click({ button: "right", position: { x: listBox.width / 2, y: listBox.height - 10 } });
  await alice.getByRole("menuitem", { name: "Create channel" }).click();
  await alice.getByRole("radio", { name: "Voice" }).click();
  await alice.getByLabel("Name").fill("Den");
  await alice.getByRole("button", { name: "Create", exact: true }).click();
  await lounge.getByText("bob").hover();
  await alice.mouse.down();
  const den = (await alice.getByRole("link", { name: "Den" }).boundingBox())!;
  await alice.mouse.move(den.x + den.width / 2, den.y + den.height / 2, { steps: 10 });
  await alice.mouse.up();
  const denList = alice.getByRole("list", { name: "In voice: Den" });
  await expect(denList.getByText("bob")).toBeVisible();
  await expect(lounge.getByText("bob")).toHaveCount(0);

  await bob.getByRole("region", { name: "Voice" }).getByRole("button", { name: "Disconnect" }).click();
  await expect(denList.getByText("bob")).toHaveCount(0);

  // Categories: alice creates "Hangouts" and moves #general into it from the channel settings.
  await alice.getByRole("button", { name: "Datrope menu" }).click();
  await alice.getByRole("menuitem", { name: "Create category" }).click();
  await alice.getByLabel("Name").fill("Hangouts");
  await alice.getByRole("button", { name: "Create", exact: true }).click();
  await expect(alice.getByRole("button", { name: "Hangouts" })).toBeVisible();
  const generalRow = alice.getByRole("link", { name: "general" });
  await generalRow.hover();
  await alice.getByRole("button", { name: "Options for general" }).click();
  await alice.getByRole("menuitem", { name: "Channel settings" }).click();
  await alice.getByLabel("Category", { exact: true }).selectOption({ label: "Hangouts" });
  // Topic: set in the same dialog; the header shows it.
  await alice.getByLabel("Topic", { exact: true }).fill("Plans and memes");
  await alice.getByRole("button", { name: "Save", exact: true }).click();
  await expect(alice.getByRole("group", { name: "Hangouts" }).getByRole("link", { name: "general" })).toBeVisible();
  await expect(bob.getByRole("group", { name: "Hangouts" }).getByRole("link", { name: "general" })).toBeVisible();

  await alice.getByRole("link", { name: "general" }).click();
  const aliceGeneral = alice.getByRole("main", { name: "# general" });
  await expect(aliceGeneral.getByRole("button", { name: "Plans and memes" })).toBeVisible();
  await bob.getByRole("link", { name: "general" }).click();
  const bobGeneral = bob.getByRole("main", { name: "# general" });
  await expect(bobGeneral.getByRole("button", { name: "Plans and memes" })).toBeVisible();

  // Threads: alice starts a thread on bob's "me!" and replies in the panel.
  const meForAlice = aliceGeneral.getByRole("article").filter({ hasText: "me!" });
  await meForAlice.hover();
  await meForAlice.getByRole("button", { name: "Create thread", exact: true }).click();
  const aliceThread = alice.getByRole("complementary", { name: "Thread" });
  await expect(aliceThread).toBeVisible();
  await aliceThread.getByLabel("Reply in thread").fill("pizza at 7?");
  await aliceThread.getByLabel("Reply in thread").press("Enter");
  await expect(aliceThread.getByText("pizza at 7?")).toBeVisible();

  // bob sees "1 reply" under his message, opens the thread and answers; alice sees "2 replies".
  const meForBob = bobGeneral.getByRole("article").filter({ hasText: "me!" });
  await meForBob.getByRole("button", { name: /^1 reply/ }).click();
  const bobThread = bob.getByRole("complementary", { name: "Thread" });
  await expect(bobThread.getByText("pizza at 7?")).toBeVisible();
  await bobThread.getByLabel("Reply in thread").fill("deal");
  await bobThread.getByLabel("Reply in thread").press("Enter");
  await expect(aliceThread.getByText("deal", { exact: true })).toBeVisible();
  await expect(meForAlice.getByRole("button", { name: /^2 replies/ })).toBeVisible();

  // Pins: alice pins her pizza message; bob finds it under "Pinned messages".
  const pizzaInGeneral = aliceGeneral.getByRole("article").filter({ hasText: "who wants pizza? @bob" }).first();
  await pizzaInGeneral.hover();
  await pizzaInGeneral.getByRole("button", { name: "Pin message", exact: true }).click();
  await expect(pizzaInGeneral.getByRole("button", { name: "Unpin message", exact: true })).toBeVisible();
  await pizzaInGeneral.click({ button: "right" });
  await expect(alice.getByRole("menuitem", { name: "Copy text" })).toBeVisible();
  await alice.keyboard.press("Escape");
  await bobGeneral.getByRole("button", { name: "Pinned messages" }).click();
  await expect(bob.getByRole("dialog").getByText("who wants pizza?")).toBeVisible();
  await bob.keyboard.press("Escape");

  // Profile: alice fills in her pronouns and "About me", and uploads an avatar.
  await alice.getByRole("button", { name: "Your settings" }).click();
  await alice.getByLabel("Pronouns", { exact: true }).fill("she/her");
  await alice.getByLabel("About me", { exact: true }).fill("Board games and synths");
  await alice.getByRole("button", { name: "Add link", exact: true }).click();
  await alice.getByRole("menuitem", { name: "GitHub" }).click();
  await expect(alice.getByLabel("Link 1", { exact: true })).toHaveValue("https://github.com/");
  await alice.getByLabel("Link 1", { exact: true }).fill("https://github.com/alice");
  await alice.getByRole("button", { name: "Save", exact: true }).click();
  await expect(alice.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await alice.getByLabel("Choose an avatar image").setInputFiles(PARROT_PNG);
  const crop = alice.getByRole("dialog", { name: "Crop your avatar" });
  await expect(crop).toBeVisible();
  await crop.getByRole("button", { name: "Apply" }).click();
  // The avatar's <img> has alt="" (decorative), so it has no img role.
  await expect(alice.getByRole("region", { name: "Profile", exact: true }).locator('img[src*="/api/avatars/"]')).toBeVisible();
  // The banner: a 3:1 strip is cropped to 960 x 320 and uploaded.
  await alice.getByLabel("Choose a banner image").setInputFiles({ name: "banner.png", mimeType: "image/png", buffer: solidPng(600, 200) });
  const bannerCrop = alice.getByRole("dialog", { name: "Crop your banner" });
  await expect(bannerCrop).toBeVisible();
  await bannerCrop.getByRole("button", { name: "Apply" }).click();
  await expect(alice.getByRole("region", { name: "Profile", exact: true }).locator('img[src*="/api/banners/"]')).toBeVisible();
  await alice.keyboard.press("Escape"); // leaves the settings page
  // Appearance: a theme re-skins the app and stays on this device.
  await alice.getByRole("button", { name: "Your settings" }).click();
  await alice.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Appearance" }).click();
  await alice.getByRole("radio", { name: "Gotham" }).click();
  await expect.poll(() => alice.evaluate(() => document.documentElement.style.getPropertyValue("--sidebar"))).toBe("#0a0f14");
  await alice.getByRole("radio", { name: "Datrope" }).click();
  await alice.keyboard.press("Escape");
  // Voice & audio: push to talk shows the key instead of the sensitivity, and stays on this device.
  await alice.getByRole("button", { name: "Your settings" }).click();
  await alice.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Voice & audio" }).click();
  await expect(alice.getByLabel("Input device")).toBeVisible();
  await expect(alice.getByRole("slider", { name: "Input sensitivity" })).toBeVisible();
  await alice.getByRole("radio", { name: "Push to talk" }).click();
  await expect(alice.getByRole("button", { name: /^Push-to-talk key/ })).toBeVisible();
  await expect(alice.getByRole("slider", { name: "Input sensitivity" })).toHaveCount(0);
  await expect.poll(() => alice.evaluate(() => JSON.parse(localStorage.getItem("datrope.audioPrefs") ?? "{}").mode)).toBe("ptt");
  await alice.getByRole("radio", { name: "Voice activity" }).click();
  await alice.keyboard.press("Escape");
  // Right-click a channel: its menu offers the link.
  await alice.getByRole("link", { name: "general" }).click({ button: "right" });
  await expect(alice.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  await alice.keyboard.press("Escape");
  await alice.getByRole("link", { name: "general" }).click();

  // Popover: bob opens alice's profile from her name, then the full profile in the drawer.
  const aliceName = bobGeneral.getByRole("article").getByRole("button", { name: "alice", exact: true }).first();
  await aliceName.click();
  const popover = bob.getByRole("dialog", { name: "alice" });
  await expect(popover.getByText("she/her")).toBeVisible();
  await expect(popover.getByText("Board games and synths")).toBeVisible();
  await expect(popover.getByText("Member since")).toBeVisible();
  const githubLink = popover.getByRole("link", { name: "GitHub on github.com" });
  await expect(githubLink).toHaveAttribute("href", "https://github.com/alice");
  await expect(githubLink).toHaveAttribute("rel", "noopener noreferrer");
  await expect(popover.locator('img[src*="/api/banners/"]')).toBeVisible();
  const sideColumns = await bob.locator("aside").count();
  await popover.getByRole("button", { name: "View full profile" }).click();
  const profile = bob.getByRole("dialog", { name: "Profile" });
  await expect(profile.getByText("Board games and synths")).toBeVisible();
  await expect(bob.locator("aside")).toHaveCount(sideColumns); // the drawer covers the right column instead of replacing it
  await profile.getByRole("button", { name: "Close profile" }).click();
  await expect(profile).toHaveCount(0);

  // Search: bob finds the pizza message and jumps to it.
  const searchBox = bob.getByRole("textbox", { name: "Search", exact: true });
  await searchBox.fill("pizza");
  await searchBox.press("Enter");
  const results = bob.getByRole("complementary", { name: "Search results" });
  const hit = results.getByRole("button").filter({ hasText: "who wants pizza?" }).first();
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(bobGeneral.getByRole("article").filter({ hasText: "who wants pizza? @bob" }).first()).toBeInViewport();
  await results.getByRole("button", { name: "Close search" }).click();

  // Inbox: bob has read #general, so he opens the DM with alice and she mentions him again; the badge counts it.
  await bob.getByRole("tab", { name: /^Messages/ }).click();
  await bob.getByRole("link", { name: /alice/ }).click();
  await expect(bob.getByRole("heading", { name: "alice" })).toBeVisible();
  await alice.getByRole("link", { name: "general" }).click();
  await send(alice, "@bob pizza is here");
  await expect(bob.getByRole("button", { name: "Inbox", exact: true })).toContainText("1"); // the badge is aria-hidden
  // Both mentions are listed; "Mark all read" clears the unread dot.
  await bob.getByRole("button", { name: "Inbox", exact: true }).click();
  const inbox = bob.getByRole("dialog", { name: "Inbox" });
  await expect(inbox.getByText("who wants pizza?")).toBeVisible();
  await expect(inbox.getByRole("img", { name: "Unread" })).toHaveCount(1);
  await inbox.getByRole("button", { name: "Mark all read" }).click();
  await expect(inbox.getByRole("img", { name: "Unread" })).toHaveCount(0);
  await bob.keyboard.press("Escape");

  // Webhooks: alice creates a webhook channel; nobody can post in it, not even its owner.
  await alice.getByRole("button", { name: "Datrope menu" }).click();
  await alice.getByRole("menuitem", { name: "Create channel" }).click();
  await alice.getByRole("radio", { name: "Webhook" }).click();
  await alice.getByLabel("Name").fill("alerts");
  await alice.getByRole("button", { name: "Create", exact: true }).click();
  const aliceAlerts = alice.getByRole("main", { name: "# alerts" });
  await expect(aliceAlerts.getByText("Only webhooks can post in this channel.")).toBeVisible();
  await expect(aliceAlerts.getByLabel("Message", { exact: true })).toHaveCount(0);

  // Channel settings → Webhooks: "CI" is created and its URL shown once.
  await alice.getByRole("link", { name: "alerts" }).hover();
  await alice.getByRole("button", { name: "Options for alerts" }).click();
  await alice.getByRole("menuitem", { name: "Channel settings" }).click();
  await alice.getByRole("tab", { name: "Webhooks" }).click();
  await alice.getByLabel("Webhook name").fill("CI");
  await alice.getByRole("button", { name: "Create webhook" }).click();
  const hookUrl = await alice.getByLabel("Webhook URL").inputValue();
  expect(hookUrl).toMatch(/\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{43}$/);
  await alice.keyboard.press("Escape");

  // A service posts in Discord's format, with no session (the test's own request context never logs in); bob sees the message and its embed.
  const posted = await request.post(new URL(hookUrl).pathname, {
    data: {
      content: "Build passed",
      embeds: [{
        title: "v1.2.3", description: "**All** checks green", color: 0x2ecc71,
        fields: [{ name: "Branch", value: "main", inline: true }, { name: "Commit", value: "abc123", inline: true }],
        footer: { text: "nightly" },
      }],
    },
  });
  expect(posted.status()).toBe(204);
  await bob.getByRole("tab", { name: "Channels" }).click();
  await bob.getByRole("link", { name: "alerts" }).click();
  const bobAlerts = bob.getByRole("main", { name: "# alerts" });
  const hookMessage = bobAlerts.getByRole("article").filter({ hasText: "Build passed" });
  await expect(hookMessage).toBeVisible();
  await expect(hookMessage.getByRole("button", { name: "CI", exact: true })).toBeVisible();
  await expect(hookMessage.getByText("Webhook", { exact: true })).toBeVisible();
  await expect(hookMessage.getByText("v1.2.3")).toBeVisible();
  await expect(hookMessage.getByText("Branch")).toBeVisible();
  await expect(hookMessage.locator("strong").filter({ hasText: "All" })).toBeVisible(); // the description's Markdown
  await expect(bobAlerts.getByText("Only webhooks can post in this channel.")).toBeVisible();
});

test("a visitor joins with a guest link and shows up as a guest", async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  await alice.goto("/login");
  await alice.getByLabel("Username or email").fill("alice");
  await alice.getByLabel("Password", { exact: true }).fill("password123");
  await alice.getByRole("button", { name: "Sign in" }).click();
  await expect(alice.getByRole("button", { name: "Datrope menu" })).toBeVisible();

  await openServerSettings(alice);
  await alice.getByRole("link", { name: "Invites" }).click();
  await alice.getByRole("switch", { name: "Guest link" }).click();
  await alice.getByLabel("Guest access lasts").selectOption({ label: "24 hours" });
  await alice.getByRole("button", { name: "Create invite" }).click();
  const link = await alice.getByLabel("New invite link").inputValue();

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(link);
  await guest.getByLabel("Nickname").fill("Robin");
  await guest.getByRole("button", { name: "Join as guest" }).click();
  await expect(guest.getByRole("status").filter({ hasText: "You're a guest" })).toBeVisible();
  // The first test turned the rules gate on.
  await guest.getByRole("button", { name: "I accept the rules" }).click();
  await send(guest, "hi, just visiting");

  await alice.goto("/");
  await expect(alice.getByText("hi, just visiting")).toBeVisible();
  await expect(alice.getByRole("main").getByText("Guest", { exact: true }).first()).toBeVisible();
});

async function signIn(page: Page, username: string) {
  await page.goto("/login");
  await page.getByLabel("Username or email", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill("password123");
  // Logins are limited to 5 a minute per account (refilling): wait out a 429 and try again.
  for (let attempt = 0; ; attempt++) {
    const response = page.waitForResponse((r) => r.url().endsWith("/api/auth/login"));
    await page.getByRole("button", { name: "Sign in" }).click();
    if ((await response).status() !== 429 || attempt >= 5) break;
    await page.waitForTimeout(13_000);
  }
  await expect(page.getByRole("tab", { name: "Channels" })).toBeVisible();
}

async function createChannel(page: Page, type: string, name: string) {
  await page.getByRole("button", { name: "Datrope menu" }).click();
  await page.getByRole("menuitem", { name: "Create channel" }).click();
  const dialog = page.getByRole("dialog", { name: "Create a channel" });
  await dialog.getByRole("radio", { name: type }).click();
  await dialog.getByLabel("Name").fill(name);
}

// Runs after the first test: alice owns the server and bob is a member who accepted the rules.
test("announcement, forum and gallery channels", async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  await signIn(alice, "alice");
  const bob = await (await browser.newContext()).newPage();
  await signIn(bob, "bob");

  // Announcement: alice posts a titled card; bob may not post, but replies in its thread.
  await createChannel(alice, "Announcement", "news");
  await alice.getByRole("button", { name: "Create", exact: true }).click();
  const aliceNews = alice.getByRole("main", { name: "# news" });
  await expect(aliceNews).toBeVisible();
  await aliceNews.getByLabel("Title", { exact: true }).fill("Game night");
  await aliceNews.getByLabel("Message", { exact: true }).fill("Friday at 8, bring snacks.");
  await aliceNews.getByRole("button", { name: "Post", exact: true }).click();
  const card = aliceNews.getByRole("article").filter({ hasText: "Friday at 8, bring snacks." });
  await expect(card.getByRole("heading", { name: "Game night" })).toBeVisible();
  // alice renames the announcement.
  await card.hover();
  await card.getByRole("button", { name: "Edit message" }).click();
  await card.getByLabel("Edit title").fill("Game night on Friday");
  await card.getByLabel("Edit message").press("Enter");
  await expect(card.getByRole("heading", { name: "Game night on Friday" })).toBeVisible();

  await bob.getByRole("link", { name: "news" }).click();
  const bobNews = bob.getByRole("main", { name: "# news" });
  await expect(bobNews.getByRole("note")).toContainText("Only members with Manage messages can post here.");
  await expect(bobNews.getByLabel("Message", { exact: true })).toHaveCount(0);
  const bobCard = bobNews.getByRole("article").filter({ hasText: "Friday at 8, bring snacks." });
  await expect(bobCard.getByRole("heading", { name: "Game night on Friday" })).toBeVisible();
  await bobCard.hover();
  await bobCard.getByRole("button", { name: "Create thread", exact: true }).click();
  const bobThread = bob.getByRole("complementary", { name: "Thread" });
  await bobThread.getByLabel("Reply in thread").fill("count me in");
  await bobThread.getByLabel("Reply in thread").press("Enter");
  await expect(bobThread.getByText("count me in")).toBeVisible();
  await expect(card.getByRole("button", { name: /^1 reply/ })).toBeVisible();

  // Forum: alice offers the tags Feature and Bug, requires one, and posts "Soundboard" tagged Feature.
  await createChannel(alice, "Forum", "ideas");
  const create = alice.getByRole("dialog", { name: "Create a channel" });
  await create.getByRole("button", { name: "Remove Question" }).click();
  await create.getByRole("checkbox", { name: "Require a tag on new posts" }).click();
  await create.getByRole("button", { name: "Create", exact: true }).click();
  const aliceIdeas = alice.getByRole("main", { name: "ideas" });
  await expect(aliceIdeas.getByText("No posts yet. Start one with New post.")).toBeVisible();
  await aliceIdeas.getByRole("button", { name: "New post" }).click();
  const newPost = alice.getByRole("dialog", { name: "New post" });
  await newPost.getByLabel("Title", { exact: true }).fill("Soundboard");
  await newPost.getByLabel("Message", { exact: true }).fill("Let us play sounds in voice.");
  // A tag is required: posting without one is blocked.
  await newPost.getByRole("button", { name: "Post", exact: true }).click();
  // The hint is always shown; the error repeats it.
  await expect(newPost.getByText("Pick at least one tag.", { exact: true })).toHaveCount(2);
  await expect(newPost).toBeVisible();
  await newPost.getByRole("button", { name: "Feature", exact: true }).click();
  await newPost.getByRole("button", { name: "Post", exact: true }).click();
  await expect(newPost).toHaveCount(0);
  const alicePost = alice.getByRole("complementary", { name: "Post" });
  await expect(alicePost.getByRole("heading", { name: "Soundboard" })).toBeVisible();
  await expect(alicePost.getByText("Feature", { exact: true })).toBeVisible();
  // alice leaves the forum; her own post leaves it read.
  await alice.getByRole("link", { name: "news" }).click();
  await expect(aliceNews).toBeVisible();
  const ideasLink = alice.getByRole("link", { name: "ideas" });
  await expect(ideasLink).not.toHaveClass(/font-semibold/);

  // bob filters by tag, opens the post and replies.
  await bob.getByRole("link", { name: "ideas" }).click();
  const bobIdeas = bob.getByRole("main", { name: "ideas" });
  const tags = bobIdeas.getByRole("group", { name: "Filter by tag" });
  await tags.getByRole("button", { name: "Bug", exact: true }).click();
  await expect(bobIdeas.getByText("No posts match.")).toBeVisible();
  await tags.getByRole("button", { name: "Feature", exact: true }).click();
  const row = bobIdeas.getByRole("list", { name: "Posts" }).getByRole("button", { name: /Soundboard/ });
  await expect(row).toBeVisible();
  await expect(row.getByText("Feature", { exact: true })).toBeVisible();
  await row.click();
  const bobPost = bob.getByRole("complementary", { name: "Post" });
  await expect(bobPost.getByText("Let us play sounds in voice.")).toBeVisible();
  await bobPost.getByLabel("Reply to post").fill("yes please");
  await bobPost.getByLabel("Reply to post").press("Enter");
  await expect(bobPost.getByText("yes please")).toBeVisible();
  // The reply makes the forum unread for alice until she opens it.
  await expect(ideasLink).toHaveClass(/font-semibold/);
  await ideasLink.click();
  await expect(ideasLink).not.toHaveClass(/font-semibold/);
  await aliceIdeas.getByRole("list", { name: "Posts" }).getByRole("button", { name: /Soundboard/ }).click();
  await expect(alicePost.getByText("yes please")).toBeVisible();

  // Gallery: alice uploads parrot.png with a caption; bob opens the tile and comments.
  await createChannel(alice, "Gallery", "photos");
  await alice.getByRole("button", { name: "Create", exact: true }).click();
  const alicePhotos = alice.getByRole("main", { name: "photos" });
  await expect(alicePhotos.getByText("No files yet", { exact: true })).toBeVisible();
  await alicePhotos.getByRole("button", { name: "Upload" }).click();
  const upload = alice.getByRole("dialog", { name: "Upload files" });
  const chooser = alice.waitForEvent("filechooser");
  await upload.getByRole("button", { name: "Choose files" }).click();
  await (await chooser).setFiles(PARROT_PNG);
  await expect(upload.getByRole("list", { name: "Files" })).toContainText("parrot.png");
  await upload.getByLabel("Caption").fill("Board night");
  await upload.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(upload).toHaveCount(0);
  await expect(alicePhotos.getByRole("button", { name: "Photo: Board night, by alice" })).toBeVisible();

  await bob.getByRole("link", { name: "photos" }).click();
  const tile = bob.getByRole("main", { name: "photos" }).getByRole("button", { name: "Photo: Board night, by alice" });
  await expect(tile).toBeVisible();
  await tile.click();
  const details = bob.getByRole("dialog", { name: "Photo details" });
  await expect(details.getByRole("img", { name: "parrot.png" })).toBeVisible();
  const comments = details.getByRole("region", { name: "Comments" });
  await comments.getByLabel("Comment").fill("Nice");
  await comments.getByLabel("Comment").press("Enter");
  await expect(comments.getByText("Nice", { exact: true })).toBeVisible();
  await expect(comments.getByRole("heading", { name: "1 comment" })).toBeVisible();
  // Once the thread exists, comments go through the app's composer.
  await expect(comments.getByRole("button", { name: "Emoji" })).toBeVisible();
  await comments.getByLabel("Comment", { exact: true }).fill("And the dice");
  await comments.getByLabel("Comment", { exact: true }).press("Enter");
  await expect(comments.getByText("And the dice", { exact: true })).toBeVisible();
  await expect(comments.getByRole("heading", { name: "2 comments" })).toBeVisible();
});

// Runs after the first tests: alice and bob exist; #general is shared.
test("gallery sources: files from other channels, music player and playlists", async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  await signIn(alice, "alice");
  const bob = await (await browser.newContext()).newPage();
  await signIn(bob, "bob");

  // State-changing API calls with the session cookie need the CSRF header.
  const CSRF = { "X-Datrope-CSRF": "1" };
  const put = (path: string, data: object) => alice.request.put(path, { headers: CSRF, data });

  // alice shares a song in #general and a picture in a channel only she can see.
  await alice.getByRole("link", { name: "general" }).click();
  await alice.locator('input[type="file"]').setInputFiles({ name: "riff-idea.wav", mimeType: "audio/wav", buffer: silentWav() });
  await expect(alice.getByRole("list", { name: "Attachments" })).not.toContainText("Uploading");
  await alice.getByRole("button", { name: "Send" }).click();
  const server = await (await alice.request.get("/api/server")).json() as { id: string };
  const priv = await (await alice.request.post("/api/server/channels", { headers: CSRF, data: { name: "alice-only", type: "text" } })).json() as { id: string };
  expect((await put(`/api/channels/${priv.id}/overrides/role/${server.id}`, { allow: 0, deny: 1 })).ok()).toBe(true);
  await alice.getByRole("link", { name: "alice-only" }).click();
  await alice.locator('input[type="file"]').setInputFiles({ name: "secret.png", mimeType: "image/png", buffer: solidPng(8, 8) });
  await expect(alice.getByRole("list", { name: "Attachments" })).not.toContainText("Uploading");
  await alice.getByRole("button", { name: "Send" }).click();
  await expect(alice.getByRole("main").getByRole("img", { name: "secret.png" })).toBeVisible();

  // There is no built-in gallery; alice makes one that shows every channel.
  await expect(bob.getByRole("link", { name: "general" })).toBeVisible();
  await expect(bob.getByRole("link", { name: "Gallery", exact: true })).toHaveCount(0);
  await createChannel(alice, "Gallery", "everything");
  await alice.getByRole("dialog", { name: "Create a channel" }).getByRole("radio", { name: /Every channel/ }).click();
  await alice.getByRole("button", { name: "Create", exact: true }).click();
  await expect(alice.getByRole("main", { name: "everything" })).toBeVisible();
  const galleryId = new URL(alice.url()).pathname.split("/").pop()!;

  // bob sees the song, tagged #general; the private picture is not there.
  await bob.getByRole("link", { name: "everything" }).click();
  const gallery = bob.getByRole("main", { name: "everything" });
  await expect(gallery.getByText("from all channels")).toBeVisible();
  await expect(gallery.getByRole("button", { name: "Track: riff-idea.wav, by alice, in #general" })).toBeVisible();
  await expect(gallery.getByRole("button", { name: /secret\.png/ })).toHaveCount(0);

  // Search and the Music filter, the player and a playlist.
  await bob.getByLabel("Search files").fill("riff");
  await expect(gallery.getByRole("button", { name: /riff-idea\.wav/ }).first()).toBeVisible();
  await bob.getByRole("toolbar", { name: "Filters" }).getByRole("group", { name: "Show" }).getByRole("button", { name: "Music" }).click();
  await gallery.getByRole("button", { name: "Play all" }).click();
  await expect(bob.getByRole("region", { name: "Music player" })).toContainText("riff-idea.wav");
  await gallery.getByRole("button", { name: "More for riff-idea.wav" }).click();
  await bob.getByRole("menuitem", { name: "Add to playlist" }).click();
  await bob.getByRole("menuitem", { name: "New playlist…" }).click();
  await bob.getByLabel("Name", { exact: true }).fill("Bob's riffs");
  await bob.getByRole("button", { name: "Create", exact: true }).click();
  await gallery.getByRole("tab", { name: "Playlists" }).click();
  await gallery.getByRole("button", { name: "Open Bob's riffs" }).click();
  await expect(gallery.getByRole("table", { name: "Tracks" })).toContainText("riff-idea");

  // Narrowed to alice-only, the gallery shows bob nothing: a source never grants access.
  const patched = await alice.request.patch(`/api/channels/${galleryId}`, { headers: CSRF, data: { gallery_sources: "selected", source_channel_ids: [priv.id] } });
  expect(patched.ok()).toBe(true);
  await bob.goto(`/channels/${galleryId}`);
  await expect(bob.getByRole("main", { name: "everything" }).getByText("No files yet", { exact: true })).toBeVisible();
});

// Runs after the first test: alice and bob exist and #general is there.
test("code blocks, pasted snippets and code file previews", async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  await signIn(alice, "alice");
  const bob = await (await browser.newContext()).newPage();
  await signIn(bob, "bob");
  await alice.getByRole("link", { name: "general" }).click();
  await bob.getByRole("link", { name: "general" }).click();
  const box = alice.getByLabel("Message", { exact: true });

  // A fenced block is highlighted for bob.
  await send(alice, "```ts\nconst answer: number = 42;\n```");
  const block = bob.locator(".code-block").filter({ hasText: "const answer" });
  await expect(block).toBeVisible();
  await expect(block.locator(".hljs-keyword").first()).toHaveText("const");
  await expect(block.getByRole("button", { name: "Copy code" })).toBeVisible();

  // The code button wraps the selection.
  await box.fill("let x = 1");
  await box.selectText();
  await alice.getByRole("button", { name: "Code block" }).click();
  await expect(box).toHaveValue(/^```\w*\nlet x = 1\n```$/);
  await box.fill("");

  // A long paste becomes a snippet file: renamed, sent, previewed, opened in full.
  const code = Array.from({ length: 60 }, (_, i) => `export const v${i}: number = ${i};`).join("\n");
  await box.evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, code);
  const name = alice.getByLabel("Snippet file name");
  await expect(name).toHaveValue(/^snippet\.\w+$/);
  await expect(box).toHaveValue("");
  await name.fill("values.ts");
  await name.press("Enter");
  await expect(alice.getByRole("list", { name: "Attachments" })).not.toContainText("Uploading");
  await alice.getByRole("button", { name: "Send" }).click();

  const preview = bob.locator(".code-block").filter({ hasText: "values.ts" });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("v14");
  await expect(preview).not.toContainText("v15");
  await bob.getByRole("button", { name: "Show all 60 lines" }).click();
  await expect(bob.getByRole("dialog", { name: "values.ts" })).toContainText("v59");
  await bob.keyboard.press("Escape");

  // An uploaded .go file previews the same way.
  await alice.locator('input[type="file"]').setInputFiles({
    name: "main.go", mimeType: "text/plain", buffer: Buffer.from('package main\n\nfunc main() {\n\tprintln("hi")\n}\n'),
  });
  await alice.getByRole("button", { name: "Send" }).click();
  await expect(bob.locator(".code-block").filter({ hasText: "main.go" }).locator(".hljs-keyword").first()).toHaveText("package");
});

// Runs after the first test: alice owns the server and bob is a member who accepted the rules.
test("members pick roles on the welcome page, which unlock channels and can be pinged", async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  await signIn(alice, "alice");
  const bob = await (await browser.newContext()).newPage();
  await signIn(bob, "bob");

  // State-changing API calls with the session cookie need the CSRF header.
  const CSRF = { "X-Datrope-CSRF": "1" };
  const put = (path: string, data: object) => alice.request.put(path, { headers: CSRF, data });

  // alice creates a self-assignable, mentionable role and a channel only it can see (setup through the API).
  const role = await (await alice.request.post("/api/server/roles", {
    headers: CSRF, data: { name: "Raiders", permissions: 0, self_assignable: true, mentionable: true, description: "Raid nights on Friday" },
  })).json() as { id: string };
  const server = await (await alice.request.get("/api/server")).json() as { id: string };
  const raids = await (await alice.request.post("/api/server/channels", { headers: CSRF, data: { name: "raids", type: "text" } })).json() as { id: string };
  expect((await put(`/api/channels/${raids.id}/overrides/role/${server.id}`, { allow: 0, deny: 1 })).ok()).toBe(true);
  expect((await put(`/api/channels/${raids.id}/overrides/role/${role.id}`, { allow: 1, deny: 0 })).ok()).toBe(true);

  // bob picks the role on the welcome page and #raids appears.
  await expect(bob.getByRole("link", { name: "raids" })).toHaveCount(0);
  await bob.getByRole("link", { name: "welcome" }).click();
  await bob.getByRole("switch", { name: /Raiders/ }).click();
  await expect(bob.getByRole("switch", { name: /Raiders/ })).toBeChecked();
  await expect(bob.getByRole("link", { name: "raids" })).toBeVisible();

  // alice pings the role from autocomplete; bob sees it as a mention of him.
  await alice.getByRole("link", { name: "raids" }).click();
  await alice.getByLabel("Message", { exact: true }).fill("tonight @Raid");
  await alice.getByRole("option", { name: /@Raiders/ }).click();
  await alice.getByLabel("Message", { exact: true }).press("Enter");
  await bob.getByRole("link", { name: "raids" }).click();
  const msg = bob.getByRole("main", { name: "# raids" }).getByRole("article").filter({ hasText: "tonight" });
  await expect(msg.locator(".mention[data-me]")).toHaveText("@Raiders");
  await bob.getByRole("button", { name: "Inbox", exact: true }).click();
  await expect(bob.getByRole("dialog", { name: "Inbox" }).getByText("@Raiders")).toBeVisible();
});

// Runs after the first test: alice is the instance admin, bob a member.
test("the instance admin sees the system dashboard and updates", async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  await signIn(alice, "alice");
  await openServerSettings(alice);
  await alice.getByRole("link", { name: "System" }).click();
  await expect(alice.getByRole("heading", { name: "Host" })).toBeVisible();
  await expect(alice.getByRole("heading", { name: "Containers" })).toBeVisible();
  await expect(alice.getByText("Uploaded files")).toBeVisible();
  // The e2e stack leaves the updater out (profile "updater" in docker-compose.e2e.yml) and sets no token.
  await expect(alice.getByText("DATROPE_UPDATER_TOKEN")).toBeVisible();

  await alice.getByRole("link", { name: /^Updates/ }).click();
  await expect(alice.getByRole("heading", { name: "Server" })).toBeVisible();
  await expect(alice.getByRole("heading", { name: "yt-dlp" })).toBeVisible();

  const bob = await (await browser.newContext()).newPage();
  await signIn(bob, "bob");
  await bob.goto("/server-settings/system");
  // Wait for the settings shell to render for bob, so the negative checks cannot pass before it loads.
  await expect(bob.getByRole("navigation", { name: "Server settings" })).toBeVisible();
  await expect(bob.getByRole("link", { name: "System" })).toHaveCount(0);
  await expect(bob.getByRole("heading", { name: "Host" })).toHaveCount(0);
});

// Runs after the first tests: alice and bob exist; #general is shared.
test("albums live in a gallery: collect a file, upload into the album, share it with the gallery", async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  await signIn(alice, "alice");
  const bob = await (await browser.newContext()).newPage();
  await signIn(bob, "bob");

  await alice.getByRole("link", { name: "general" }).click();
  await alice.locator('input[type="file"]').setInputFiles({ name: "harbour.png", mimeType: "image/png", buffer: solidPng(8, 8) });
  await expect(alice.getByRole("list", { name: "Attachments" })).not.toContainText("Uploading");
  await alice.getByRole("button", { name: "Send" }).click();

  // A gallery fed by #general, picked in the dialog.
  await createChannel(alice, "Gallery", "trips");
  const dialog = alice.getByRole("dialog", { name: "Create a channel" });
  await dialog.getByRole("radio", { name: /Channels I pick/ }).click();
  await dialog.getByRole("group", { name: "Channels" }).getByRole("checkbox", { name: "general", exact: true }).click();
  await alice.getByRole("button", { name: "Create", exact: true }).click();
  const trips = alice.getByRole("main", { name: "trips" });
  await expect(trips.getByRole("button", { name: /^Photo: harbour.png/ })).toBeVisible();

  // A private album from the deck row, then the #general picture into it.
  await trips.getByRole("region", { name: "Albums" }).getByRole("button", { name: "New album" }).click();
  const newAlbum = alice.getByRole("dialog", { name: "New album" });
  await newAlbum.getByLabel("Name").fill("Lofoten");
  await newAlbum.getByRole("radio", { name: "Only collaborators" }).click();
  await newAlbum.getByRole("button", { name: "Create" }).click();
  await expect(alice.getByRole("heading", { name: "Lofoten" })).toBeVisible();
  await alice.getByRole("link", { name: "trips" }).first().click();
  await trips.getByRole("button", { name: /^Photo: harbour\.png/ }).first().hover();
  await trips.getByRole("button", { name: "More for harbour.png" }).click();
  await alice.getByRole("menuitem", { name: "Add to album" }).click();
  await alice.getByRole("menuitemcheckbox", { name: /Lofoten/ }).click();
  await alice.keyboard.press("Escape");

  // Upload into the album: it is posted in the gallery and filed into the album.
  await trips.getByRole("link", { name: /^Lofoten, / }).click();
  const album = alice.getByRole("main", { name: "Album" });
  await expect(album.getByRole("button", { name: /^Photo: harbour.png/ })).toBeVisible();
  await album.getByRole("button", { name: "Upload" }).click();
  const upload = alice.getByRole("dialog", { name: "Upload files" });
  const chooser = alice.waitForEvent("filechooser");
  await upload.getByRole("button", { name: "Choose files" }).click();
  await (await chooser).setFiles({ name: "fjord.png", mimeType: "image/png", buffer: solidPng(8, 8) });
  await expect(upload.getByRole("list", { name: "Files" })).not.toContainText("Uploading");
  await upload.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(album.getByRole("button", { name: /^Photo: fjord.png/ })).toBeVisible();

  // bob doesn't see the private album; shared with the gallery, he sees both files.
  await bob.getByRole("link", { name: "trips" }).click();
  const bobTrips = bob.getByRole("main", { name: "trips" });
  await expect(bobTrips.getByRole("button", { name: /^Photo: harbour.png/ })).toBeVisible();
  await expect(bobTrips.getByRole("region", { name: "Albums" }).getByRole("button", { name: "New album" })).toBeVisible();
  await expect(bobTrips.getByRole("link", { name: /^Lofoten, / })).toHaveCount(0);
  await alice.getByRole("button", { name: "Album settings" }).click();
  await alice.getByRole("radio", { name: "Everyone in this gallery" }).click();
  await alice.getByRole("button", { name: "Save" }).click();
  await bobTrips.getByRole("link", { name: /^Lofoten, / }).click();
  const bobAlbum = bob.getByRole("main", { name: "Album" });
  await expect(bobAlbum.getByRole("button", { name: /^Photo: harbour.png/ })).toBeVisible();
  await expect(bobAlbum.getByRole("button", { name: /^Photo: fjord.png/ })).toBeVisible();
  await expect(bobAlbum.getByRole("button", { name: "Upload" })).toHaveCount(0);
});

test("personal notes: write a note, it survives a reload, then delete it", async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  await signIn(alice, "alice");

  await alice.getByRole("tab", { name: "Notes" }).click();
  await alice.getByRole("button", { name: "New note" }).click();
  await expect(alice).toHaveURL(/\/notes\/\d+$/);
  const noteLink = alice.getByRole("navigation", { name: "Notes", exact: true }).locator(`a[href="${new URL(alice.url()).pathname}"]`);
  await alice.getByLabel("Title").fill("Raid roster");
  await alice.getByRole("textbox", { name: "Note" }).click();
  await alice.keyboard.type("Bring flasks");
  await alice.getByRole("button", { name: "Checklist" }).click();
  await alice.keyboard.type("Tank");
  await expect(alice.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

  await alice.reload();
  await expect(alice.getByLabel("Title")).toHaveValue("Raid roster");
  await expect(alice.getByRole("textbox", { name: "Note" })).toContainText("Bring flasks");
  await expect(alice.getByRole("textbox", { name: "Note" }).locator('ul[data-type="taskList"]')).toContainText("Tank");
  await expect(noteLink).toContainText("Raid roster");

  await alice.getByRole("button", { name: "Note options" }).click();
  await alice.getByRole("menuitem", { name: "Delete note" }).click();
  await alice.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(alice).toHaveURL(/\/notes$/);
  await expect(noteLink).toHaveCount(0);
});
