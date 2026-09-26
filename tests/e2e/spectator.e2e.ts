import { expect, test } from "@playwright/test";

const OTHER_ROOMS = ["balcony", "couch", "dancefloor", "porch"];

function nonce(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

async function checkinToken(
  request: import("@playwright/test").APIRequestContext,
): Promise<string> {
  const response = await request.post("/api/checkin", { data: {} });
  expect(response.status()).toBe(201);
  const json = (await response.json()) as { token: string };
  return json.token;
}

test("4.2 message posted via API appears in the right box, no other", async ({
  page,
  request,
}) => {
  const marker = nonce("e2e42");
  await page.goto("/");
  await expect(page.locator("section.room")).toHaveCount(5);
  const token = await checkinToken(request);
  const posted = await request.post("/api/rooms/kitchen/messages", {
    headers: { Authorization: `Bearer ${token}` },
    data: { body: marker },
  });
  expect(posted.status()).toBe(201);
  await expect(
    page.locator('section.room[data-room="kitchen"] .messages li', {
      hasText: marker,
    }),
  ).toBeVisible({ timeout: 2000 });
  for (const slug of OTHER_ROOMS) {
    await expect(
      page.locator(`section.room[data-room="${slug}"] .messages li`, {
        hasText: marker,
      }),
    ).toHaveCount(0);
  }
});

const XSS_CASES: Array<{ name: string; payload: string; literal: string }> = [
  {
    name: "img onerror",
    payload: '<img src=x onerror="alert(1)">',
    literal: '<img src=x onerror="alert(1)">',
  },
  {
    name: "script breakout",
    payload: "</script><script>alert(1)</script>",
    literal: "</script>",
  },
  {
    name: "javascript url",
    payload: "javascript:alert(1)",
    literal: "javascript:alert(1)",
  },
  {
    name: "direction override",
    payload: "‮reversed",
    literal: "‮reversed",
  },
];

for (const { name, payload, literal } of XSS_CASES) {
  test(`4.4 xss renders literally: ${name}`, async ({ page, request }) => {
    let dialogFired = false;
    page.on("dialog", (dialog) => {
      dialogFired = true;
      void dialog.dismiss();
    });
    const marker = nonce("e2e44");
    await page.goto("/");
    await expect(page.locator("section.room")).toHaveCount(5);
    const token = await checkinToken(request);
    const posted = await request.post("/api/rooms/couch/messages", {
      headers: { Authorization: `Bearer ${token}` },
      data: { body: `${marker} ${payload}` },
    });
    expect(posted.status()).toBe(201);
    const item = page.locator(
      'section.room[data-room="couch"] .messages li',
      { hasText: marker },
    );
    await expect(item).toBeVisible({ timeout: 5000 });
    await expect(item).toContainText(literal, { timeout: 5000 });
    expect(dialogFired).toBe(false);
    expect(await page.locator("img").count()).toBe(0);
    expect(await page.locator("script[src]").count()).toBe(1);
  });
}
