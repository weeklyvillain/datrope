import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

// A 1x1 PNG.
const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
// A custom emoji image (a 1x1 PNG); its name comes from the file name.
const PARROT_PNG = fileURLToPath(new URL("./fixtures/parrot.png", import.meta.url));
// The Ocean palette's accent (#4aa3ff) as getComputedStyle reports it.
const OCEAN = "rgb(74, 163, 255)";

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

test("the owner sets up the server, a friend joins by invite, accepts the rules, and they chat", async ({ browser }) => {
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

  // Soundboard: alice plays Boop; bob sees the chip on alice's tile.
  await alice.getByRole("main", { name: "Lounge" }).getByRole("button", { name: "Soundboard" }).click();
  await alice.getByRole("dialog", { name: "Soundboard" }).getByRole("button", { name: "Play Boop, 0.5 s" }).click();
  const bobMain = bob.getByRole("main", { name: "Lounge" });
  await expect(bobMain.getByRole("status").filter({ hasText: "Boop" })).toContainText("\u{1F514}");

  // Per-person volume: bob turns alice up to 150 % just for himself; her tile shows the badge.
  await bobMain.getByRole("button", { name: "More options for alice" }).first().click({ force: true });
  await bob.getByRole("slider", { name: "Volume for alice, just for you" }).fill("150");
  await expect(bobMain.getByRole("img", { name: "Volume changed" }).first()).toBeVisible();
  await bob.keyboard.press("Escape");

  await bob.getByRole("button", { name: "Mute" }).click();
  await expect(lounge.getByRole("img", { name: "Muted" })).toBeVisible();

  // Moving: alice drags bob from Lounge onto a second voice channel.
  await alice.getByRole("button", { name: "Datrope menu" }).click();
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

  await bob.getByRole("button", { name: "Disconnect" }).click();
  await expect(denList.getByText("bob")).toHaveCount(0);

  // Categories: alice creates "Hangouts" and moves #general into it from the channel settings.
  await alice.getByRole("button", { name: "Datrope menu" }).click();
  await alice.getByRole("menuitem", { name: "Create category" }).click();
  await alice.getByLabel("Name").fill("Hangouts");
  await alice.getByRole("button", { name: "Create", exact: true }).click();
  await expect(alice.getByRole("button", { name: "Hangouts" })).toBeVisible();
  const generalRow = alice.getByRole("link", { name: "general" });
  await generalRow.hover();
  await alice.getByRole("button", { name: "Settings for general" }).click();
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
  await alice.keyboard.press("Escape"); // closes the settings modal
  // Appearance: a theme re-skins the app and stays on this device.
  await alice.getByRole("button", { name: "Your settings" }).click();
  await alice.getByRole("dialog").getByRole("button", { name: "Appearance" }).click();
  await alice.getByRole("radio", { name: "Gotham" }).click();
  await expect.poll(() => alice.evaluate(() => document.documentElement.style.getPropertyValue("--sidebar"))).toBe("#0a0f14");
  await alice.getByRole("radio", { name: "Datrope" }).click();
  await alice.keyboard.press("Escape");
  // Right-click a channel: its menu offers the link.
  await alice.getByRole("link", { name: "general" }).click({ button: "right" });
  await expect(alice.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  await alice.keyboard.press("Escape");
  await alice.getByRole("link", { name: "general" }).click();

  // Popover: bob opens alice's profile from her name, then the full profile in the side panel.
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
  await popover.getByRole("button", { name: "View full profile" }).click();
  const profile = bob.getByRole("complementary", { name: "Profile" });
  await expect(profile.getByText("Board games and synths")).toBeVisible();
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
});
