import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import type Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import {
  createApp,
  type LogEntry,
  type VolumeReport,
} from "../src/http/app.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

type Harness = {
  base: string;
  db: Database.Database;
};

async function startHarness(
  options: {
    checkinLimit?: number;
    volumeLogMs?: number;
    onVolume?: (report: VolumeReport) => void;
  } = {},
): Promise<Harness> {
  const db = openDatabase(":memory:");
  const logs: LogEntry[] = [];
  const app = createApp(db, (entry) => logs.push(entry), {
    checkinLimit: 10000,
    sweepers: true,
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

it("serves the spectator page with exact content types", async () => {
  const { base } = await startHarness();
  const page = await fetch(`${base}/`, {
    headers: { Accept: "text/html,application/xhtml+xml" },
  });
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(page.headers.get("cache-control")).toBe("no-store");
  const html = await page.text();
  expect(html).toContain('id="rooms"');
  for (const slug of ["kitchen", "balcony", "couch", "dancefloor", "porch"]) {
    expect(html).toContain(`data-room="${slug}"`);
  }
  const js = await fetch(`${base}/app.js`);
  expect(js.status).toBe(200);
  expect(js.headers.get("content-type")).toBe(
    "text/javascript; charset=utf-8",
  );
  const css = await fetch(`${base}/style.css`);
  expect(css.status).toBe(200);
  expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
  expect((await fetch(`${base}/admin`)).status).toBe(404);
  expect((await fetch(`${base}/app.js.map`)).status).toBe(404);
});

it("5.2: GET / negotiates onboarding JSON vs the spectator page", async () => {
  const { base } = await startHarness();
  const json = await fetch(`${base}/`, {
    headers: { Accept: "application/json" },
  });
  expect(json.status).toBe(200);
  expect(json.headers.get("content-type")).toContain("application/json");
  const onboarding = (await json.json()) as {
    service: string;
    flow: string[];
    rooms: Array<{ slug: string }>;
    rules: Record<string, unknown>;
    limits: Record<string, unknown>;
    full_docs: string;
  };
  expect(onboarding.service).toBe("ai-hangout");
  expect(onboarding.flow).toHaveLength(3);
  expect(onboarding.rooms.map((room) => room.slug)).toEqual([
    "kitchen",
    "balcony",
    "couch",
    "dancefloor",
    "porch",
  ]);
  expect(onboarding.rules.cooldown_seconds).toBe(8);
  expect(onboarding.full_docs).toBe("/llms.txt");
  const page = await fetch(`${base}/`, {
    headers: { Accept: "text/html,application/xhtml+xml" },
  });
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await page.text()).toContain('id="rooms"');
});

it("5.7: volume reports count posts per room since the last line", async () => {
  const reports: VolumeReport[] = [];
  const { base } = await startHarness({
    volumeLogMs: 50,
    onVolume: (report) => reports.push(report),
  });
  const checkin = await fetch(`${base}/api/checkin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(checkin.status).toBe(201);
  const { token } = (await checkin.json()) as { token: string };
  const post = await fetch(`${base}/api/rooms/kitchen/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ body: "volume probe" }),
  });
  expect(post.status).toBe(201);
  const start = Date.now();
  while (
    !reports.some((report) => report.total > 0) &&
    Date.now() - start < 5000
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(reports[0]).toEqual({
    event: "volume",
    rooms: { kitchen: 1 },
    total: 1,
  });
});

it("4.5: no innerHTML-style sinks in the shipped client", () => {
  const source = readFileSync(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  for (const sink of [
    "innerHTML",
    "outerHTML",
    "insertAdjacentHTML",
    "document.write",
  ]) {
    expect(source.includes(sink)).toBe(false);
  }
});
