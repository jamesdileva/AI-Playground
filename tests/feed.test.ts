import { serve } from "@hono/node-server";
import type Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { createApp, type LogEntry } from "../src/http/app.js";
import { createHub, type FeedEvent } from "../src/feed/hub.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

it("hub fans out to subscribers and drops them on unsubscribe", () => {
  const hub = createHub();
  const seenA: FeedEvent[] = [];
  const seenB: FeedEvent[] = [];
  const offA = hub.subscribe((event) => {
    seenA.push(event);
  });
  hub.subscribe((event) => {
    seenB.push(event);
  });
  expect(hub.count()).toBe(2);
  hub.publish({ type: "checkin", total_checkins: 3 });
  expect(seenA).toEqual([{ type: "checkin", total_checkins: 3 }]);
  expect(seenB).toEqual([{ type: "checkin", total_checkins: 3 }]);
  offA();
  expect(hub.count()).toBe(1);
  hub.publish({ type: "presence", room: "kitchen", occupants: 0 });
  expect(seenA).toHaveLength(1);
  expect(seenB).toHaveLength(2);
});

it("hub isolates a throwing subscriber", () => {
  const hub = createHub();
  hub.subscribe(() => {
    throw new Error("boom");
  });
  const seen: FeedEvent[] = [];
  hub.subscribe((event) => {
    seen.push(event);
  });
  hub.publish({ type: "checkin", total_checkins: 1 });
  expect(seen).toEqual([{ type: "checkin", total_checkins: 1 }]);
});

type FeedHarness = {
  base: string;
  db: Database.Database;
  feedSubscribers: () => number;
};

async function startFeedHarness(clock?: () => number): Promise<FeedHarness> {
  const db = openDatabase(":memory:");
  const logs: LogEntry[] = [];
  let feedSubscribers = () => 0;
  const app = createApp(db, (entry) => logs.push(entry), {
    checkinLimit: 10000,
    now: clock,
    feedKeepaliveMs: 60,
    onInternals: (internals) => {
      feedSubscribers = internals.feedSubscribers;
    },
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
  return {
    base: `http://127.0.0.1:${address.port}`,
    db,
    feedSubscribers: () => feedSubscribers(),
  };
}

type ParsedEvent = { event?: string; data?: string; comment?: string };

async function openFeed(base: string) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/feed`, {
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  if (!response.body) throw new Error("Missing feed body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: ParsedEvent[] = [];
  let buffer = "";
  let stopped = false;
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || stopped) return;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf("\n\n");
        while (idx >= 0) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const parsed: ParsedEvent = {};
          for (const line of raw.split("\n")) {
            if (line.startsWith(":")) {
              parsed.comment = `${parsed.comment ?? ""}${line.slice(1).trim()}`;
            } else if (line.startsWith("event:")) {
              parsed.event = line.slice("event:".length).trim();
            } else if (line.startsWith("data:")) {
              parsed.data = `${parsed.data ?? ""}${line.slice("data:".length).trim()}`;
            }
          }
          events.push(parsed);
          idx = buffer.indexOf("\n\n");
        }
      }
    } catch {
      return;
    }
  })();
  cleanup.unshift(async () => {
    stopped = true;
    controller.abort();
    try {
      await reader.cancel();
    } catch {
      return;
    }
    await pump;
  });
  return {
    events,
    async waitFor(
      predicate: (event: ParsedEvent) => boolean,
      timeoutMs = 5000,
    ): Promise<ParsedEvent> {
      const start = Date.now();
      for (;;) {
        const found = events.find(predicate);
        if (found) return found;
        if (Date.now() - start > timeoutMs) {
          throw new Error(
            `Timed out waiting for feed event; saw ${JSON.stringify(events)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
  };
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

it("feed emits a message event when an agent posts", async () => {
  const { base } = await startFeedHarness();
  const feed = await openFeed(base);
  const agent = await newAgent(base);
  const posted = await post(base, "kitchen", agent.token, "hello feed");
  expect(posted.status).toBe(201);
  const event = await feed.waitFor((entry) => entry.event === "message");
  expect(JSON.parse(event.data ?? "")).toMatchObject({
    room: "kitchen",
    id: posted.json.id,
    handle: agent.handle,
    body: "hello feed",
    created_at: posted.json.created_at,
  });
});

it("feed emits checkin events with the running total", async () => {
  const { base } = await startFeedHarness();
  const feed = await openFeed(base);
  await newAgent(base);
  const first = await feed.waitFor((entry) => entry.event === "checkin");
  expect(JSON.parse(first.data ?? "")).toEqual({ total_checkins: 1 });
  await newAgent(base);
  await feed.waitFor(
    (entry) =>
      entry.event === "checkin" &&
      (JSON.parse(entry.data ?? "") as { total_checkins: number })
        .total_checkins === 2,
  );
});

it("feed emits presence only when occupancy changes", async () => {
  const { base } = await startFeedHarness();
  const feed = await openFeed(base);
  const agent = await newAgent(base);
  const authed = await fetch(`${base}/api/rooms/kitchen/messages?since=0`, {
    headers: { Authorization: `Bearer ${agent.token}` },
  });
  expect(authed.status).toBe(200);
  const joined = await feed.waitFor((entry) => entry.event === "presence");
  expect(JSON.parse(joined.data ?? "")).toEqual({
    room: "kitchen",
    occupants: 1,
  });
  const presenceEvents = () =>
    feed.events.filter((entry) => entry.event === "presence").length;
  const seen = presenceEvents();
  const reread = await fetch(`${base}/api/rooms/kitchen/messages?since=0`, {
    headers: { Authorization: `Bearer ${agent.token}` },
  });
  expect(reread.status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(presenceEvents()).toBe(seen);
  const left = await fetch(`${base}/api/rooms/kitchen/leave`, {
    method: "POST",
    headers: { Authorization: `Bearer ${agent.token}` },
  });
  expect(left.status).toBe(204);
  const gone = await feed.waitFor(
    (entry) =>
      entry.event === "presence" &&
      (JSON.parse(entry.data ?? "") as { occupants: number }).occupants === 0,
  );
  expect(JSON.parse(gone.data ?? "")).toEqual({
    room: "kitchen",
    occupants: 0,
  });
});

it("feed sends keepalive comments", async () => {
  const { base } = await startFeedHarness();
  const feed = await openFeed(base);
  const alive = await feed.waitFor(
    (entry) => (entry.comment ?? "").includes("keepalive"),
    5000,
  );
  expect(alive.event).toBeUndefined();
});

it("feed unsubscribes when the client disconnects", async () => {
  const harness = await startFeedHarness();
  const controller = new AbortController();
  const response = await fetch(`${harness.base}/api/feed`, {
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const start = Date.now();
  while (harness.feedSubscribers() < 1 && Date.now() - start < 5000) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(harness.feedSubscribers()).toBe(1);
  controller.abort();
  const stop = Date.now();
  while (harness.feedSubscribers() > 0 && Date.now() - stop < 10000) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(harness.feedSubscribers()).toBe(0);
});
