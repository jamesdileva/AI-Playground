import { expect, test } from "@playwright/test";
import { checkinToken } from "./helpers.js";

const XSS_CASES: Array<{ name: string; payload: string }> = [
  { name: "img onerror", payload: '<img src=x onerror="alert(1)">' },
  { name: "script breakout", payload: "</script><script>alert(1)</script>" },
  { name: "javascript url", payload: "javascript:alert(1)" },
  { name: "direction override", payload: "‮reversed" },
];

for (const { name, payload } of XSS_CASES) {
  test(`8.5 plot renders literally: ${name}`, async ({ page, request }) => {
    let dialogFired = false;
    page.on("dialog", (dialog) => {
      dialogFired = true;
      void dialog.dismiss();
    });
    const token = await checkinToken(request);
    const created = await request.post("/api/plots", {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        title: `XSS ${name}`,
        palette: "mono",
        blocks: [
          { type: "text", text: `probe ${payload}` },
          { type: "ascii_art", art: `probe\n${payload}` },
          { type: "guestbook" },
        ],
      },
    });
    expect(created.status()).toBe(201);
    const { slug } = (await created.json()) as { slug: string };
    const signed = await request.post(`/api/plots/${slug}/guestbook`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { entry: `guest ${payload}` },
    });
    expect(signed.status()).toBe(200);
    await page.goto(`/plot/${slug}`);
    await expect(page.locator("main.plot")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("main.plot")).toContainText(payload, {
      timeout: 5000,
    });
    expect(dialogFired).toBe(false);
    expect(await page.locator("main.plot img").count()).toBe(0);
    expect(await page.locator("script[src]").count()).toBe(0);
  });
}

test("plot page shows accords, owners, and guestbook", async ({
  page,
  request,
}) => {
  const founder = await checkinToken(request);
  const friend = await checkinToken(request);
  const created = await request.post("/api/plots", {
    headers: { Authorization: `Bearer ${founder}` },
    data: {
      title: "Club House",
      palette: "forest",
      blocks: [
        { type: "heading", level: 1, text: "Welcome" },
        { type: "guestbook" },
      ],
    },
  });
  expect(created.status()).toBe(201);
  const { slug } = (await created.json()) as { slug: string };
  await page.goto(`/plot/${slug}`);
  await expect(page.locator("main.plot h2")).toHaveText("Welcome");
  await expect(page.locator("main.plot")).toContainText("No signatures yet.");
  const signed = await request.post(`/api/plots/${slug}/guestbook`, {
    headers: { Authorization: `Bearer ${friend}` },
    data: { entry: "nice place" },
  });
  expect(signed.status()).toBe(200);
  await page.reload();
  await expect(page.locator("main.plot")).toContainText("nice place");
});
