import { expect, test } from "@playwright/test";
import { checkinToken } from "./helpers.js";

const XSS_CASES: Array<{ name: string; payload: string }> = [
  { name: "img onerror", payload: '<img src=x onerror="alert(1)">' },
  { name: "script breakout", payload: "</script><script>alert(1)</script>" },
  { name: "javascript url", payload: "javascript:alert(1)" },
  { name: "direction override", payload: "‮reversed" },
];

test("10.14 gallery renders probes as literal text", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  let dialogFired = false;
  page.on("dialog", (dialog) => {
    dialogFired = true;
    void dialog.dismiss();
  });
  const founder = await checkinToken(request);
  const friend = await checkinToken(request);
  const painters = [founder, friend];
  for (const [index, { payload }] of XSS_CASES.entries()) {
    const painted = await request.post("/api/canvas", {
      headers: { Authorization: `Bearer ${painters[index % 2]!}` },
      data: {
        ops: [
          {
            op: "text",
            x: 50,
            y: 50,
            text: payload,
            color: "#ffffff",
            size: 12,
          },
        ],
      },
    });
    expect(painted.status()).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 8500));
  }
  const proposed = await request.post("/api/canvas/finish/propose", {
    headers: { Authorization: `Bearer ${founder}` },
  });
  expect(proposed.status()).toBe(201);
  const confirmed = await request.post("/api/canvas/finish/confirm", {
    headers: { Authorization: `Bearer ${friend}` },
  });
  expect(confirmed.status()).toBe(200);
  const created = await request.post("/api/plots", {
    headers: { Authorization: `Bearer ${founder}` },
    data: {
      title: "Gallery probes",
      palette: "mono",
      blocks: [
        ...XSS_CASES.map(({ payload }): { type: string; text?: string } => ({
          type: "text",
          text: `probe ${payload}`,
        })),
        { type: "guestbook" },
      ],
    },
  });
  expect(created.status()).toBe(201);
  const { slug } = (await created.json()) as { slug: string };
  const signed = await request.post(`/api/plots/${slug}/guestbook`, {
    headers: { Authorization: `Bearer ${friend}` },
    data: { entry: `guest ${XSS_CASES[0]!.payload}` },
  });
  expect(signed.status()).toBe(200);
  const retired = await request.post(`/api/plots/${slug}/retire`, {
    headers: { Authorization: `Bearer ${founder}` },
  });
  expect(retired.status()).toBe(200);

  await page.goto("/gallery");
  await expect(page.locator("main.gallery")).toBeVisible({ timeout: 10000 });
  for (const { payload } of XSS_CASES) {
    await expect(page.locator("main.gallery")).toContainText(payload, {
      timeout: 5000,
    });
  }
  expect(dialogFired).toBe(false);
  expect(
    await page.locator("main.gallery img:not([src^='data:'])").count(),
  ).toBe(0);

  const detail = await request.get(`/api/gallery/plot/${slug}`);
  expect(detail.status()).toBe(200);
  const detailJson = (await detail.json()) as {
    blocks: Array<{ text?: string }>;
  };
  const texts = detailJson.blocks.map((block) => block.text ?? "");
  for (const { payload } of XSS_CASES) {
    expect(texts).toContain(`probe ${payload}`);
  }
  expect(detail.headers()["content-type"]).toContain("application/json");
});

test("scrubber replays painted history on the board", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const token = await checkinToken(request);
  for (let n = 0; n < 3; n++) {
    const painted = await request.post("/api/canvas", {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        ops: [
          {
            op: "rect",
            x: 50 + n * 200,
            y: 50,
            w: 100,
            h: 100,
            color: "#ff8800",
            fill: true,
          },
        ],
      },
    });
    expect(painted.status()).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 8500));
  }
  await page.goto("/");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: 10000 });
  await page.locator("#scrub-replay").click();
  const range = page.locator("#scrub-range");
  await expect(range).toBeEnabled({ timeout: 30000 });
  const max = Number(await range.getAttribute("max"));
  expect(max).toBeGreaterThan(0);
  await range.fill(`${max}`);
  await expect(page.locator("#scrub-live")).toBeEnabled();
  await page.locator("#scrub-live").click();
  await expect(page.locator("#scrub-range")).toBeDisabled({ timeout: 10000 });
});
