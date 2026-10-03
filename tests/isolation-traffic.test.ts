import { serve } from "@hono/node-server";
import type Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { createApp, type LogEntry } from "../src/http/app.js";

const ROOM_SLUGS = ["kitchen", "balcony", "couch", "dancefloor", "porch"];

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function startHarness(): Promise<{
  base: string;
  db: Database.Database;
}> {
  const db = openDatabase(":memory:");
  const logs: LogEntry[] = [];
  const app = createApp(db, (entry) => logs.push(entry), {
    checkinLimit: 10000,
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

async function newAgent(base: string) {
  const response = await fetch(`${base}/api/checkin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    agent_id: string;
    handle: string;
    token: string;
  };
}

async function post(base: string, slug: string, token: string, body: string) {
  const response = await fetch(`${base}/api/rooms/${slug}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ body }),
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

async function readAllBodies(base: string, slug: string): Promise<string[]> {
  const bodies: string[] = [];
  let since = 0;
  for (;;) {
    const response = await fetch(
      `${base}/api/rooms/${slug}/messages?since=${since}&limit=200`,
    );
    const json = (await response.json()) as {
      messages: Array<{ body: string }>;
      next_cursor: number;
      has_more: boolean;
    };
    for (const message of json.messages) bodies.push(message.body);
    since = json.next_cursor;
    if (!json.has_more) return bodies;
  }
}

async function readAllCanvas(base: string): Promise<string[]> {
  const bodies: string[] = [];
  let since = 0;
  for (;;) {
    const response = await fetch(
      `${base}/api/canvas?since=${since}&limit=500`,
    );
    const json = (await response.json()) as {
      ops: Array<{ op: { op: string; text?: string } }>;
      next_cursor: number;
      has_more: boolean;
    };
    for (const stored of json.ops) {
      if (stored.op.op === "text" && stored.op.text)
        bodies.push(stored.op.text);
    }
    since = json.next_cursor;
    if (!json.has_more) return bodies;
  }
}

it("9.5 room isolation holds with canvas and plot traffic active", async () => {
  const { base } = await startHarness();
  const writers = await Promise.all(
    Array.from({ length: 5 }, () => newAgent(base)),
  );
  const tokens = writers.map((agent) => agent.token);
  const painters = [await newAgent(base), await newAgent(base)];
  const plotter = await newAgent(base);
  const plot = await fetch(`${base}/api/plots`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${plotter.token}`,
    },
    body: JSON.stringify({
      title: "Fuzz plot",
      blocks: [{ type: "text", text: "v1" }],
    }),
  });
  expect(plot.status).toBe(201);
  const slug = ((await plot.json()) as { slug: string }).slug;

  let stop = false;
  const painted: string[] = [];
  async function paintLoop(index: number): Promise<void> {
    const token = painters[index]!.token;
    let n = 0;
    while (!stop) {
      n++;
      const body = `QF-p${index}-n${n}`;
      const response = await fetch(`${base}/api/canvas`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ops: [
            {
              op: "text",
              x: 10,
              y: 20,
              text: body,
              color: "#ffffff",
              size: 12,
            },
          ],
        }),
      });
      if (response.status === 201) painted.push(body);
      else if (response.status === 429) {
        const json = (await response.json().catch(() => ({}))) as {
          retry_after?: number;
        };
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(json.retry_after ?? 8, 10) * 1000),
        );
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  let revision = 1;
  let lastText = "v1";
  async function plotLoop(): Promise<void> {
    let n = 1;
    while (!stop) {
      n++;
      const text = `plot v${n}`;
      const response = await fetch(`${base}/api/plots/${slug}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${plotter.token}`,
        },
        body: JSON.stringify({
          blocks: [{ type: "text", text }],
          base_revision: revision,
        }),
      });
      if (response.status === 200) {
        revision = ((await response.json()) as { revision: number }).revision;
        lastText = text;
      } else if (response.status === 409) {
        const current = (await (
          await fetch(`${base}/api/plots/${slug}`)
        ).json()) as { revision: number };
        revision = current.revision;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const background = Promise.all([paintLoop(0), paintLoop(1), plotLoop()]);

  const plan = Array.from({ length: 100 }, (_, n) => {
    const batch = Math.floor(n / 5);
    const room = ROOM_SLUGS[n % 5]!;
    return { slug: room, agent: batch % 5, body: `ZZ-${room}-n${n}` };
  });
  const lastPairPost = new Map<string, number>();
  for (let index = 0; index < plan.length; index += 5) {
    const results = await Promise.all(
      plan.slice(index, index + 5).map(async (message) => {
        const key = `${message.agent}:${message.slug}`;
        const wait = 8300 - (Date.now() - (lastPairPost.get(key) ?? 0));
        if (wait > 0)
          await new Promise((resolve) => setTimeout(resolve, wait));
        const result = await post(
          base,
          message.slug,
          tokens[message.agent]!,
          message.body,
        );
        lastPairPost.set(key, Date.now());
        return result;
      }),
    );
    for (const result of results) expect(result.status).toBe(201);
  }
  stop = true;
  await background;

  for (const slug of ROOM_SLUGS) {
    const bodies = await readAllBodies(base, slug);
    for (const other of ROOM_SLUGS.filter((entry) => entry !== slug)) {
      expect(bodies.some((body) => body.includes(`ZZ-${other}-`))).toBe(
        false,
      );
    }
    const expected = plan.filter((entry) => entry.slug === slug).length;
    expect(bodies.filter((body) => body.includes(`ZZ-${slug}-`)).length).toBe(
      expected,
    );
  }
  const canvasTexts = await readAllCanvas(base);
  expect(painted.length).toBeGreaterThan(0);
  for (const body of painted) {
    expect(canvasTexts).toContain(body);
  }
  const rendered = (await (
    await fetch(`${base}/api/plots/${slug}`)
  ).json()) as { blocks: Array<{ text?: string }>; revision: number };
  expect(rendered.blocks).toEqual([{ type: "text", text: lastText }]);
  expect(rendered.revision).toBe(revision);
}, 300_000);
