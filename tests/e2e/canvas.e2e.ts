import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { checkinToken } from "./helpers.js";

const BACKGROUND: [number, number, number] = [34, 34, 51];

async function paint(
  request: APIRequestContext,
  token: string,
  ops: unknown,
): Promise<number> {
  const response = await request.post("/api/canvas", {
    headers: { Authorization: `Bearer ${token}` },
    data: { ops },
  });
  return response.status();
}

async function paintedPixels(page: Page): Promise<number> {
  return page.evaluate(([br, bg, bb]) => {
    const canvas = document.getElementById("canvas") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    const data = ctx.getImageData(0, 0, 1000, 1000).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== br || data[i + 1] !== bg || data[i + 2] !== bb) count++;
    }
    return count;
  }, BACKGROUND);
}

test("canvas paints ops posted via the API", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.locator("#canvas")).toBeVisible();
  const before = await paintedPixels(page);
  const token = await checkinToken(request);
  expect(
    await paint(request, token, [
      {
        op: "rect",
        x: 10,
        y: 10,
        w: 60,
        h: 40,
        color: "#ff8800",
        fill: true,
      },
    ]),
  ).toBe(201);
  await expect
    .poll(() => paintedPixels(page), { timeout: 5000 })
    .toBeGreaterThan(before + 1000);
});

const XSS_CASES: Array<{ name: string; payload: string }> = [
  { name: "img onerror", payload: '<img src=x onerror="alert(1)">' },
  { name: "script breakout", payload: "</script><script>alert(1)</script>" },
  { name: "javascript url", payload: "javascript:alert(1)" },
  { name: "direction override", payload: "‮reversed" },
];

for (const { name, payload } of XSS_CASES) {
  test(`6.6 canvas text renders literally: ${name}`, async ({
    page,
    request,
  }) => {
    let dialogFired = false;
    page.on("dialog", (dialog) => {
      dialogFired = true;
      void dialog.dismiss();
    });
    await page.goto("/");
    await expect(page.locator("#canvas")).toBeVisible();
    const token = await checkinToken(request);
    expect(
      await paint(request, token, [
        {
          op: "text",
          x: 400,
          y: 400,
          text: payload,
          color: "#ffffff",
          size: 24,
        },
      ]),
    ).toBe(201);
    await expect
      .poll(() => paintedPixels(page), { timeout: 5000 })
      .toBeGreaterThan(100);
    expect(dialogFired).toBe(false);
    expect(await page.locator("img").count()).toBe(0);
    expect(await page.locator("script[src]").count()).toBe(1);
  });
}
