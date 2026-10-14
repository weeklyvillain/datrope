import { expect, test, type Page } from "@playwright/test";

// The login endpoint is rate limited (5 per name), so sign in once per worker and reuse the session cookies.
type Cookies = Parameters<ReturnType<Page["context"]>["addCookies"]>[0];
const sessions = new Map<string, Cookies>();

async function signIn(page: Page, username: string) {
  const tabs = page.getByRole("navigation", { name: "Tabs" });
  const saved = sessions.get(username);
  if (saved) {
    await page.context().addCookies(saved);
    await page.goto("/");
    if (await expect(tabs).toBeVisible({ timeout: 5000 }).then(() => true, () => false)) return;
  }
  for (let i = 0; i < 5; i++) {
    await page.goto("/login");
    await page.getByLabel("Username or email").fill(username);
    await page.getByLabel("Password", { exact: true }).fill("password123");
    await page.getByRole("button", { name: /sign in/i }).click();
    if (await expect(tabs).toBeVisible({ timeout: 5000 }).then(() => true, () => false)) {
      sessions.set(username, await page.context().cookies());
      return;
    }
    await page.waitForTimeout(3000);
  }
  throw new Error(`could not sign in as ${username}`);
}

async function openChannel(page: Page, name: string) {
  await page.getByRole("link", { name: "Server", exact: true }).click();
  await page.getByRole("link", { name: new RegExp(`^${name}`) }).first().click();
  await expect(page.getByRole("log", { name: "Messages" })).toBeVisible();
}

const MARK = `line two ${Date.now()}`;

test.describe.configure({ mode: "serial" });

test("tab bar shows on roots and hides inside a conversation", async ({ page }) => {
  await signIn(page, "alice");
  const tabs = page.getByRole("navigation", { name: "Tabs" });
  await expect(tabs).toBeVisible();
  await openChannel(page, "general");
  await expect(tabs).toBeHidden();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(tabs).toBeVisible();
});

test("Return adds a line on touch and Send sends a multi-line message", async ({ page }) => {
  await signIn(page, "alice");
  await openChannel(page, "general");
  const box = page.getByLabel("Message", { exact: true });
  await box.click();
  await box.pressSequentially("line one");
  await box.press("Enter");
  await box.pressSequentially(MARK);
  await expect(box).toHaveValue(`line one\n${MARK}`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("log", { name: "Messages" }).getByText(MARK)).toBeVisible();
});

test("long-press opens the action sheet and adds the first reaction", async ({ page }) => {
  await signIn(page, "alice");
  await openChannel(page, "general");
  const msg = page.locator("article").filter({ hasText: MARK }).last();
  await msg.scrollIntoViewIfNeeded();
  const box = (await msg.boundingBox())!;
  const pt = { pointerType: "touch", clientX: box.x + 60, clientY: box.y + 10, isPrimary: true };
  await msg.dispatchEvent("pointerdown", pt);
  await page.waitForTimeout(650);
  await msg.dispatchEvent("pointerup", pt);
  await expect(page.getByRole("menu", { name: "Message actions" })).toBeVisible();
  await page.getByRole("button", { name: "React with 👍" }).click();
  await expect(msg.getByRole("button", { name: /👍/ })).toBeVisible();
});

test("swipe right sets the reply target", async ({ page }) => {
  await signIn(page, "alice");
  await openChannel(page, "general");
  const msg = page.locator("article").filter({ hasText: MARK }).last();
  await msg.scrollIntoViewIfNeeded();
  const b = (await msg.boundingBox())!;
  const y = b.y + 10;
  const ev = (x: number) => ({ pointerType: "touch", clientX: b.x + x, clientY: y, isPrimary: true });
  await msg.dispatchEvent("pointerdown", ev(20));
  for (const x of [35, 60, 90, 110]) await msg.dispatchEvent("pointermove", ev(x));
  await msg.dispatchEvent("pointerup", ev(110));
  await expect(page.getByText(/Replying to/)).toBeVisible();
});

test("back closes the thread panel before leaving the channel", async ({ page }) => {
  await signIn(page, "alice");
  await openChannel(page, "general");
  const url = page.url();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Threads" }).click();
  await expect(page).toHaveURL(/panel=threads/);
  await page.goBack();
  await expect(page).toHaveURL(url);
  await expect(page.getByRole("log", { name: "Messages" })).toBeVisible();
});

test("server settings: list then section then back", async ({ page }) => {
  // alice owns the server in the e2e stack; E2E_OWNER points at the owner of a pre-seeded instance.
  await signIn(page, process.env.E2E_OWNER ?? "alice");
  await page.getByRole("link", { name: "You", exact: true }).click();
  await page.getByRole("link", { name: "Server settings" }).click();
  await page.getByRole("link", { name: "Members" }).click();
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/server-settings$/);
});

test("key controls are at least 44px", async ({ page }) => {
  await signIn(page, "alice");
  for (const name of ["Server", "Messages", "Mentions", "You"]) {
    const b = (await page.getByRole("link", { name, exact: true }).boundingBox())!;
    expect(b.width, name).toBeGreaterThanOrEqual(44);
    expect(b.height, name).toBeGreaterThanOrEqual(44);
  }
  await openChannel(page, "general");
  for (const name of ["Back", "Search", "More actions", "Attach files", "Emoji", "Send"]) {
    const b = (await page.getByRole("button", { name, exact: true }).boundingBox())!;
    expect(b.width, name).toBeGreaterThanOrEqual(44);
    expect(b.height, name).toBeGreaterThanOrEqual(44);
  }
  const font = await page.getByLabel("Message", { exact: true }).evaluate((e) => getComputedStyle(e).fontSize);
  expect(font).toBe("16px");
});

test("rotating across 768px keeps the conversation", async ({ page }) => {
  await signIn(page, "alice");
  await openChannel(page, "general");
  const url = page.url();
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(page).toHaveURL(url);
  await expect(page.getByRole("log", { name: "Messages" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("log", { name: "Messages" })).toBeVisible();
});
