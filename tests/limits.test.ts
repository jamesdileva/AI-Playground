import { serve } from "@hono/node-server";
import type Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { createApp, type LogEntry } from "../src/http/app.js";
import type {
  MessageLimits,
  OpLimits,
  PixelBudgetLimits,
} from "../src/http/rateLimit.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function startHarness(
  options: {
    checkinLimit?: number;
    messageLimits?: MessageLimits;
    opLimits?: OpLimits;
    pixelBudgetLimits?: PixelBudgetLimits;
  } = {},
): Promise<{ base: string; db: Database.Database }> {
  const db = openDatabase(":memory:");
  const logs: LogEntry[] = [];
  const app = createApp(db, (entry) => logs.push(entry), {
    checkinLimit: 10000,
    ...options,
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  cleanup.push(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (db.open) db.close();
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing TCP address");
  return { base: `http://127.0.0.1:${address.port}`, db };
}

async function checkin(base: string) {
  const response = await fetch(`${base}/api/checkin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

function expect429(
  status: number,
  json: Record<string, unknown>,
  error: string,
) {
  expect(status).toBe(429);
  expect(json.error).toBe(error);
  expect(typeof json.retry_after).toBe("number");
  expect((json.retry_after as number) > 0).toBe(true);
  expect(typeof json.hint).toBe("string");
  expect((json.hint as string).length).toBeGreaterThan(0);
}

it("9.9 message cooldown and hourly cap carry retry_after", async () => {
  const { base } = await startHarness({
    messageLimits: { cooldownMs: 0, hourlyCap: 2 },
  });
  const agent = await checkin(base);
  const token = agent.json.token as string;
  const other = await checkin(base);
  const otherToken = other.json.token as string;
  const headers = (token: string) => ({
    "content-type": "application/json",
    Authorization: `Bearer ${token}`,
  });
  const first = await fetch(`${base}/api/rooms/kitchen/messages`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ body: "a" }),
  });
  expect(first.status).toBe(201);
  await fetch(`${base}/api/rooms/kitchen/messages`, {
    method: "POST",
    headers: headers(otherToken),
    body: JSON.stringify({ body: "b" }),
  });
  await fetch(`${base}/api/rooms/kitchen/messages`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ body: "c" }),
  });
  await fetch(`${base}/api/rooms/kitchen/messages`, {
    method: "POST",
    headers: headers(otherToken),
    body: JSON.stringify({ body: "d" }),
  });
  const capped = await fetch(`${base}/api/rooms/kitchen/messages`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ body: "e" }),
  });
  expect429(
    capped.status,
    (await capped.json()) as Record<string, unknown>,
    "hourly_cap",
  );
});

it("9.9 canvas cooldown, ops cap, and pixel budget carry retry_after", async () => {
  const { base } = await startHarness({
    opLimits: { cooldownMs: 0, cap: 1000000, windowMs: 60000 },
    pixelBudgetLimits: { budgetPx: 150, windowMs: 3600000 },
  });
  const agent = await checkin(base);
  const token = agent.json.token as string;
  const small = [
    { op: "rect", x: 1, y: 1, w: 10, h: 10, color: "#111111", fill: true },
  ];
  const first = await fetch(`${base}/api/canvas`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ ops: small }),
  });
  expect(first.status).toBe(201);
  const over = await fetch(`${base}/api/canvas`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ ops: small }),
  });
  expect429(
    over.status,
    (await over.json()) as Record<string, unknown>,
    "pixel_budget",
  );

  const refills = await startHarness({
    opLimits: { cooldownMs: 0, cap: 2, windowMs: 60000 },
    pixelBudgetLimits: { budgetPx: 100000000, windowMs: 3600000 },
  });
  const writer = await checkin(refills.base);
  const writerToken = writer.json.token as string;
  for (let n = 0; n < 2; n++) {
    const posted = await fetch(`${refills.base}/api/canvas`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${writerToken}`,
      },
      body: JSON.stringify({ ops: small }),
    });
    expect(posted.status).toBe(201);
  }
  const capped = await fetch(`${refills.base}/api/canvas`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${writerToken}`,
    },
    body: JSON.stringify({ ops: small }),
  });
  expect429(
    capped.status,
    (await capped.json()) as Record<string, unknown>,
    "ops_cap",
  );
});

it("9.9 guestbook cooldown and plot cap carry retry_after", async () => {
  const { base } = await startHarness();
  const agent = await checkin(base);
  const token = agent.json.token as string;
  const headers = {
    "content-type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  for (const title of ["A", "B", "C"]) {
    const created = await fetch(`${base}/api/plots`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title,
        blocks: [{ type: "text", text: "hi" }],
      }),
    });
    expect(created.status).toBe(201);
  }
  const fourth = await fetch(`${base}/api/plots`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: "D",
      blocks: [{ type: "text", text: "hi" }],
    }),
  });
  expect429(
    fourth.status,
    (await fourth.json()) as Record<string, unknown>,
    "plot_limit",
  );
  const list = (await (await fetch(`${base}/api/plots`)).json()) as {
    plots: Array<{ slug: string }>;
  };
  const slug = list.plots[0]!.slug;
  const signed = await fetch(`${base}/api/plots/${slug}/guestbook`, {
    method: "POST",
    headers,
    body: JSON.stringify({ entry: "hi" }),
  });
  expect(signed.status).toBe(200);
  const again = await fetch(`${base}/api/plots/${slug}/guestbook`, {
    method: "POST",
    headers,
    body: JSON.stringify({ entry: "again" }),
  });
  expect429(
    again.status,
    (await again.json()) as Record<string, unknown>,
    "guestbook_cooldown",
  );
});
