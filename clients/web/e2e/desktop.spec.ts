import { expect, test, type Locator, type Page } from "@playwright/test";

// The login endpoint is rate limited (5 per name), so sign in once per worker and reuse the session cookies.
type Cookies = Parameters<ReturnType<Page["context"]>["addCookies"]>[0];
let session: Cookies | undefined;

async function signIn(page: Page, username = "alice") {
  const log = page.getByRole("log", { name: "Messages" });
  if (session) {
    await page.context().addCookies(session);
    await page.goto("/");
    if (await expect(log).toBeVisible({ timeout: 5000 }).then(() => true, () => false)) return;
  }
  for (let i = 0; i < 5; i++) {
    await page.goto("/login");
    await page.getByLabel("Username or email").fill(username);
    await page.getByLabel("Password", { exact: true }).fill("password123");
    await page.getByRole("button", { name: /sign in/i }).click();
    if (await expect(log).toBeVisible({ timeout: 5000 }).then(() => true, () => false)) {
      session = await page.context().cookies();
      return;
    }
    await page.waitForTimeout(3000);
  }
  throw new Error(`could not sign in as ${username}`);
}
const CSRF = { "X-Datrope-CSRF": "1" };
// Texts are suffixed per project: the desktop projects run in parallel and share #general.
const tag = () => test.info().project.name;
const width = (page: Page) => page.viewportSize()!.width;
const composer = (page: Page) => page.getByLabel("Message", { exact: true });
async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press("Enter");
  await expect(page.getByText(text, { exact: true }).last()).toBeVisible();
  // Wait for the server to confirm it: a pending row has no actions yet (the row stays mounted, keyed by its nonce).
  await expect(page.locator("[data-message-row]").filter({ hasText: text }).last().locator("[data-message-menu]")).toHaveCount(1);
}
const activeIsRow = (page: Page) => page.evaluate(() => !!document.activeElement?.closest("[data-message-row]"));

// Focusing can race the list rendering its rows; retry until it sticks.
const focusRow = (row: Locator) => expect(async () => { await row.focus(); await expect(row).toBeFocused({ timeout: 1000 }); }).toPass();

test.beforeEach(async ({ page }) => { await signIn(page); });

test("the channel title stays visible and the list never scrolls sideways", async ({ page }) => {
  await expect(page.getByRole("heading", { level: 1, name: /# general/ })).toBeVisible();
  const log = page.getByRole("log", { name: "Messages" });
  expect(await log.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
});

test("narrow: the channel list opens as a sheet", async ({ page }) => {
  test.skip(width(page) >= 1024, "narrow only");
  await page.getByRole("button", { name: "Channels" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("link", { name: "news" }).click(); // created by chat.spec.ts
  await expect(page.getByRole("main", { name: "# news" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("medium and narrow: members slide over; Esc returns focus", async ({ page }) => {
  test.skip(width(page) >= 1280, "slide-over tiers only");
  const button = width(page) < 1024 ? null : page.getByRole("button", { name: "Members" });
  if (button) await button.click();
  else { await page.getByRole("button", { name: "More actions" }).click(); await page.getByRole("menuitem", { name: "Members" }).click(); }
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  if (button) await expect(button).toBeFocused();
});

test("wide: the members toggle persists across reload", async ({ page }) => {
  test.skip(width(page) < 1280, "wide only");
  const list = page.getByRole("complementary", { name: "Members" });
  await expect(list).toBeVisible();
  await page.getByRole("button", { name: "Members" }).click();
  await expect(list).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("log", { name: "Messages" })).toBeVisible();
  await expect(list).toHaveCount(0);
  await page.getByRole("button", { name: "Members" }).click();
  await expect(list).toBeVisible();
});

test("keyboard only: skip link, reply to a grouped message, delete then cancel", async ({ page }) => {
  const second = `second, grouped ${tag()}`;
  for (const t of [`first ${tag()}`, second]) await send(page, t);
  await page.reload(); // start from the top of the page
  await expect(page.getByRole("log", { name: "Messages" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to messages" })).toBeFocused();
  await page.keyboard.press("Enter");
  // The skip link lands on the newest row, which may belong to another project; check that, then take our own row.
  await expect.poll(() => activeIsRow(page)).toBe(true);
  await focusRow(page.locator("[data-message-row]").filter({ hasText: second }).last());
  await page.keyboard.press("r");
  await expect(page.getByText(/Replying to/)).toBeVisible();
  await page.getByLabel("Cancel reply").click();
  await focusRow(page.locator("[data-message-row]").filter({ hasText: second }).last());
  await page.keyboard.press("Delete");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => activeIsRow(page)).toBe(true);
});

test("Delete then Confirm moves focus to a neighbour", async ({ page }) => {
  const a = `del-a ${tag()} ${Date.now()}`, b = `del-b ${tag()} ${Date.now()}`;
  await send(page, a);
  await send(page, b);
  const row = page.locator("[data-message-row]").filter({ hasText: b }).last();
  await focusRow(row);
  const deleted = await row.getAttribute("id");
  await page.keyboard.press("Delete");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText(b, { exact: true })).toHaveCount(0);
  // A neighbour row or the composer, never the deleted row, also once the dialog's exit animation has run.
  const onNeighbour = () => page.evaluate((id) => {
    const el = document.activeElement;
    const r = el?.closest("[data-message-row]");
    return (!!r && r.id !== id) || el === document.querySelector('textarea[aria-label="Message"]');
  }, deleted);
  await expect.poll(onNeighbour).toBe(true);
  await page.waitForTimeout(600);
  expect(await onNeighbour()).toBe(true);
});

test("Enter on a focused message opens More actions", async ({ page }) => {
  const text = `menu ${tag()} ${Date.now()}`;
  await send(page, text);
  const row = page.locator("[data-message-row]").filter({ hasText: text }).last();
  await focusRow(row);
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Reply" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect.poll(() => activeIsRow(page)).toBe(true);
});

test("the threads panel closes on Esc and focus returns", async ({ page }) => {
  const threads = width(page) < 1024 ? null : page.getByRole("button", { name: "Threads" });
  test.skip(!threads, "narrow keeps Threads in the More actions menu");
  await threads!.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Threads" })).toHaveCount(0);
  await expect(threads!).toBeFocused();
});

test("resize keeps the thread", async ({ page }) => {
  test.skip(width(page) < 1280, "starts wide");
  await page.getByRole("button", { name: "Threads" }).click();
  await expect(page.getByRole("heading", { name: "Threads" }).last()).toBeVisible();
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Threads" }).last()).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Threads" }).last()).toBeVisible();
});

// Scroll to the top until the older pages have loaded (the oldest rows are not necessarily the one we want), then
// page down until the text shows.
async function scrollUntilVisible(page: Page, text: string) {
  const log = page.getByRole("log", { name: "Messages" });
  const target = page.getByText(text, { exact: true }).first();
  // In the viewport, not just rendered: overscan rows clipped by the log count as visible otherwise.
  const inView = async () => (await target.count()) > 0 && target.evaluate((el) => {
    const r = el.getBoundingClientRect(), l = document.querySelector('[role="log"]')!.getBoundingClientRect();
    return r.top >= l.top && r.bottom <= l.bottom;
  }, undefined, { timeout: 2000 }).catch(() => false);
  for (let i = 0; i < 20 && !(await inView()); i++) {
    await log.evaluate((el) => el.scrollTo({ top: 0 }));
    await page.waitForTimeout(200);
  }
  for (let i = 0; i < 60 && !(await inView()); i++) {
    await log.evaluate((el) => el.scrollBy({ top: el.clientHeight * 0.8 }));
    await page.waitForTimeout(100);
  }
  await expect(target).toBeInViewport();
}

const BULK = 160, MAX_ARTICLES = 100; // MAX_ARTICLES: well above the measured 39, well below BULK
let historyChannel = ""; // created by the first test, reused by the second (same worker, in order)

test("scrolling up loads older messages without a button", async ({ page }) => {
  test.skip(width(page) !== 1440, "once");
  test.setTimeout(180_000);
  // A channel of its own: the other desktop projects send into #general at the same time.
  historyChannel = `history-${Date.now()}`;
  const created = await page.request.post("/api/server/channels", { headers: CSRF, data: { name: historyChannel, type: "text" } });
  expect(created.ok()).toBe(true);
  const { id } = await created.json() as { id: string };
  // Enough rows that an unvirtualized list would blow far past the bound below; sent over the API for speed.
  for (let i = 0; i < BULK; i++) {
    const res = await page.request.post(`/api/channels/${id}/messages`, { headers: CSRF, data: { content: `bulk ${i}`, nonce: `bulk-${Date.now()}-${i}` } });
    expect(res.ok()).toBe(true);
  }
  await page.goto("/");
  await page.getByRole("link", { name: historyChannel }).click();
  await expect(page.getByRole("main", { name: `# ${historyChannel}` })).toBeVisible();
  await expect(page.locator("[data-message-row]").filter({ hasText: `bulk ${BULK - 1}` }).last().locator("[data-message-menu]")).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole("main", { name: `# ${historyChannel}` })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load older messages" })).toHaveCount(0);
  await scrollUntilVisible(page, "bulk 0");
  expect(await page.locator("article").count()).toBeLessThan(MAX_ARTICLES); // measured 39 with 160 messages
});

test("jump from search to an old message", async ({ page }) => {
  test.skip(width(page) !== 1440, "once");
  await page.getByRole("link", { name: historyChannel }).click();
  await expect(page.getByRole("main", { name: `# ${historyChannel}` })).toBeVisible();
  await page.getByLabel("Search", { exact: true }).fill("bulk 1");
  await page.getByLabel("Search", { exact: true }).press("Enter");
  await page.getByRole("complementary", { name: /search/i }).getByText("bulk 1", { exact: true }).first().click();
  await expect(page.locator(".message-flash").getByText("bulk 1", { exact: true })).toBeVisible();
});

test("shortcuts: sheet, channel switching, type to focus", async ({ page }) => {
  test.skip(width(page) !== 1440, "once");
  await page.locator("body").click({ position: { x: 600, y: 300 } });
  await page.keyboard.press("Control+/");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Which channel follows #general depends on what the other specs created; any other channel proves the switch.
  const title = page.getByRole("heading", { level: 1 });
  await expect(title).toHaveText(/# general/);
  await page.keyboard.press("Alt+ArrowDown");
  await expect(title).not.toHaveText(/# general/);
  await page.keyboard.press("Alt+ArrowUp");
  await expect(title).toHaveText(/# general/);
  await page.locator("body").click({ position: { x: 600, y: 300 } });
  await page.keyboard.type("h");
  await expect(composer(page)).toHaveValue("h");
});

test("settings open as a page and Esc returns to chat", async ({ page }) => {
  test.skip(width(page) < 1024, "desktop settings");
  await page.getByRole("button", { name: "Your settings" }).click();
  await expect(page.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\//);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("log", { name: "Messages" })).toBeVisible();
});
