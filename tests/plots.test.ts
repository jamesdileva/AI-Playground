import { serve } from "@hono/node-server";
import type Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { createApp, type LogEntry } from "../src/http/app.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function startHarness(checkinLimit = 10000): Promise<{
  base: string;
  db: Database.Database;
}> {
  const db = openDatabase(":memory:");
  const logs: LogEntry[] = [];
  const app = createApp(db, (entry) => logs.push(entry), { checkinLimit });
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

type Agent = { agent_id: string; handle: string; token: string };

async function newAgent(base: string): Promise<Agent> {
  const response = await fetch(`${base}/api/checkin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Agent;
}

async function api(
  base: string,
  method: string,
  path: string,
  token: string | undefined,
  body?: unknown,
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >,
    text: async () => response.text(),
  };
}

const V1 = [{ type: "heading", level: 1, text: "Our plot" }];
const V2 = [
  { type: "heading", level: 1, text: "Our plot" },
  { type: "text", text: "Built together." },
];

it("8.1 two agents co-build one plot from two tokens", async () => {
  const { base } = await startHarness();
  const founder = await newAgent(base);
  const friend = await newAgent(base);
  const created = await api(base, "POST", "/api/plots", founder.token, {
    title: "Club House",
    palette: "forest",
    blocks: V1,
  });
  expect(created.status).toBe(201);
  const slug = created.json.slug as string;
  expect(created.json.revision).toBe(1);
  const added = await api(
    base,
    "POST",
    `/api/plots/${slug}/owners`,
    founder.token,
    {
      handle: friend.handle,
    },
  );
  expect(added.status).toBe(200);
  expect(added.json.owners).toContain(friend.handle);
  const edited = await api(base, "PUT", `/api/plots/${slug}`, friend.token, {
    blocks: V2,
    base_revision: 1,
  });
  expect(edited.status).toBe(200);
  expect(edited.json.revision).toBe(2);
  const read = await api(base, "GET", `/api/plots/${slug}`, undefined);
  expect(read.status).toBe(200);
  expect(read.json.blocks).toEqual(V2);
  expect(read.json.owners).toEqual(
    expect.arrayContaining([founder.handle, friend.handle]),
  );
  expect(read.json.revision).toBe(2);
});

it("8.2 non-owners get 403, strangers get 401", async () => {
  const { base } = await startHarness();
  const founder = await newAgent(base);
  const outsider = await newAgent(base);
  const created = await api(base, "POST", "/api/plots", founder.token, {
    title: "Private",
    blocks: V1,
  });
  const slug = created.json.slug as string;
  const denied = await api(
    base,
    "PUT",
    `/api/plots/${slug}`,
    outsider.token,
    {
      blocks: V2,
      base_revision: 1,
    },
  );
  expect(denied.status).toBe(403);
  expect(denied.json.error).toBe("plot_forbidden");
  expect(String(denied.json.message)).toContain("co-owner");
  expect(String(denied.json.hint).length).toBeGreaterThan(0);
  const anonymous = await api(base, "PUT", `/api/plots/${slug}`, undefined, {
    blocks: V2,
    base_revision: 1,
  });
  expect(anonymous.status).toBe(401);
  const anonymousCreate = await api(base, "POST", "/api/plots", undefined, {
    title: "Sneaky",
    blocks: V1,
  });
  expect(anonymousCreate.status).toBe(401);
});

it("8.3 the 3-plot cap counts co-owned plots, with retry_after", async () => {
  const { base } = await startHarness();
  const founder = await newAgent(base);
  const friend = await newAgent(base);
  const first = await api(base, "POST", "/api/plots", founder.token, {
    title: "Shared",
    blocks: V1,
  });
  expect(first.status).toBe(201);
  await api(
    base,
    "POST",
    `/api/plots/${first.json.slug}/owners`,
    founder.token,
    {
      handle: friend.handle,
    },
  );
  for (const title of ["One", "Two"]) {
    const created = await api(base, "POST", "/api/plots", friend.token, {
      title,
      blocks: V1,
    });
    expect(created.status).toBe(201);
  }
  const fourth = await api(base, "POST", "/api/plots", friend.token, {
    title: "Three",
    blocks: V1,
  });
  expect(fourth.status).toBe(429);
  expect(fourth.json.error).toBe("plot_limit");
  expect(typeof fourth.json.retry_after).toBe("number");
});

it("8.4 non-declarative fields are rejected naming the field", async () => {
  const { base } = await startHarness();
  const agent = await newAgent(base);
  const cases: Array<{ name: string; blocks: unknown }> = [
    {
      name: "raw html key",
      blocks: [{ type: "text", text: "hi", html: "<b>hi</b>" }],
    },
    {
      name: "inline style",
      blocks: [{ type: "text", text: "hi", style: "color:red" }],
    },
    {
      name: "script type",
      blocks: [{ type: "script", src: "evil.js" }],
    },
    {
      name: "event handler",
      blocks: [{ type: "text", text: "hi", onclick: "alert(1)" }],
    },
    {
      name: "javascript href",
      blocks: [{ type: "link", label: "x", href: "javascript:alert(1)" }],
    },
    {
      name: "unknown type",
      blocks: [{ type: "marquee", text: "hi" }],
    },
  ];
  for (const { name, blocks } of cases) {
    const result = await api(base, "POST", "/api/plots", agent.token, {
      title: `Probe ${name}`,
      blocks,
    });
    expect(result.status, name).toBe(400);
    expect(result.json.error, name).toBe("plot_invalid");
    expect(String(result.json.hint).length, name).toBeGreaterThan(0);
  }
  const htmlCase = await api(base, "POST", "/api/plots", agent.token, {
    title: "Probe",
    blocks: [{ type: "text", text: "hi", html: "<b>x</b>" }],
  });
  expect(String(htmlCase.json.message)).toContain("html");
});

it("8.6 concurrent same-base writes: exactly one wins", async () => {
  const { base } = await startHarness();
  const founder = await newAgent(base);
  const friend = await newAgent(base);
  const created = await api(base, "POST", "/api/plots", founder.token, {
    title: "Race",
    blocks: V1,
  });
  const slug = created.json.slug as string;
  await api(base, "POST", `/api/plots/${slug}/owners`, founder.token, {
    handle: friend.handle,
  });
  const attempts = await Promise.all([
    api(base, "PUT", `/api/plots/${slug}`, founder.token, {
      blocks: [{ type: "text", text: "founder wins?" }],
      base_revision: 1,
    }),
    api(base, "PUT", `/api/plots/${slug}`, friend.token, {
      blocks: [{ type: "text", text: "friend wins?" }],
      base_revision: 1,
    }),
  ]);
  const statuses = attempts.map((attempt) => attempt.status).sort();
  expect(statuses).toEqual([200, 409]);
  const loser = attempts.find((attempt) => attempt.status === 409)!;
  expect(loser.json.error).toBe("revision_conflict");
  expect(loser.json.revision).toBe(2);
  expect(String(loser.json.hint)).toContain("merge");
});

it("8.7 twenty-five saves keep the newest twenty; restore appends", async () => {
  const { base } = await startHarness();
  const agent = await newAgent(base);
  const created = await api(base, "POST", "/api/plots", agent.token, {
    title: "Long lived",
    blocks: V1,
  });
  const slug = created.json.slug as string;
  let revision = 1;
  const bodies: Record<number, unknown> = { 1: V1 };
  for (let n = 2; n <= 25; n++) {
    const blocks = [{ type: "text", text: `revision ${n}` }];
    const saved = await api(base, "PUT", `/api/plots/${slug}`, agent.token, {
      blocks,
      base_revision: revision,
    });
    expect(saved.status).toBe(200);
    revision = saved.json.revision as number;
    bodies[revision] = blocks;
  }
  expect(revision).toBe(25);
  const history = await api(
    base,
    "GET",
    `/api/plots/${slug}/history`,
    agent.token,
  );
  expect(history.status).toBe(200);
  const revisions = (history.json.history as Array<{ revision: number }>).map(
    (entry) => entry.revision,
  );
  expect(revisions).toHaveLength(20);
  expect(revisions[0]).toBe(6);
  expect(revisions[19]).toBe(25);
  const restored = await api(
    base,
    "POST",
    `/api/plots/${slug}/restore`,
    agent.token,
    {
      revision: 6,
    },
  );
  expect(restored.status).toBe(200);
  expect(restored.json.revision).toBe(26);
  const read = await api(base, "GET", `/api/plots/${slug}`, undefined);
  expect(read.json.blocks).toEqual(bodies[6]);
  expect(read.json.revision).toBe(26);
  const missing = await api(
    base,
    "POST",
    `/api/plots/${slug}/restore`,
    agent.token,
    {
      revision: 999,
    },
  );
  expect(missing.status).toBe(404);
});

it("8.8 guestbook: one signature per agent, 60 s cooldown, text render", async () => {
  const { base, db } = await startHarness();
  const founder = await newAgent(base);
  const guest = await newAgent(base);
  const created = await api(base, "POST", "/api/plots", founder.token, {
    title: "Guestbook",
    blocks: [...V1, { type: "guestbook" }],
  });
  const slug = created.json.slug as string;
  const signed = await api(
    base,
    "POST",
    `/api/plots/${slug}/guestbook`,
    guest.token,
    {
      entry: "lovely place",
    },
  );
  expect(signed.status).toBe(200);
  const again = await api(
    base,
    "POST",
    `/api/plots/${slug}/guestbook`,
    guest.token,
    {
      entry: "twice",
    },
  );
  expect(again.status).toBe(429);
  expect(again.json.error).toBe("guestbook_cooldown");
  expect(typeof again.json.retry_after).toBe("number");
  const read = await api(base, "GET", `/api/plots/${slug}`, undefined);
  const entries = read.json.guestbook as Array<{
    handle: string;
    entry: string;
  }>;
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    handle: guest.handle,
    entry: "lovely place",
  });
  db.prepare("UPDATE plot_guestbook SET saved_at = 0").run();
  const updated = await api(
    base,
    "POST",
    `/api/plots/${slug}/guestbook`,
    guest.token,
    {
      entry: "updated signature",
    },
  );
  expect(updated.status).toBe(200);
  const reread = await api(base, "GET", `/api/plots/${slug}`, undefined);
  expect(
    (reread.json.guestbook as Array<{ entry: string }>).map(
      (row) => row.entry,
    ),
  ).toEqual(["updated signature"]);
  const long = await api(
    base,
    "POST",
    `/api/plots/${slug}/guestbook`,
    founder.token,
    {
      entry: "x".repeat(501),
    },
  );
  expect(long.status).toBe(400);
});

it("8.9 size ceilings reject before persistence; listings still render", async () => {
  const { base } = await startHarness();
  const agent = await newAgent(base);
  const many = Array.from({ length: 31 }, (_, n) => ({
    type: "text",
    text: `block ${n}`,
  }));
  const tooMany = await api(base, "POST", "/api/plots", agent.token, {
    title: "Too many",
    blocks: many,
  });
  expect(tooMany.status).toBe(400);
  expect(tooMany.json.error).toBe("plot_invalid");
  const giant = await api(base, "POST", "/api/plots", agent.token, {
    title: "Giant",
    blocks: [{ type: "text", text: "x".repeat(40000) }],
  });
  expect(giant.status).toBe(400);
  const ok = await api(base, "POST", "/api/plots", agent.token, {
    title: "Fine",
    blocks: V1,
  });
  expect(ok.status).toBe(201);
  for (const path of ["/api/plots", "/api/rooms", "/api/canvas/meta"]) {
    expect((await fetch(`${base}${path}`)).status).toBe(200);
  }
  const list = (await (await fetch(`${base}/api/plots`)).json()) as {
    plots: Array<{ slug: string; title: string }>;
  };
  expect(list.plots.map((plot) => plot.slug)).toContain(ok.json.slug);
});

it("owners: founder-only add/remove with self-removal", async () => {
  const { base } = await startHarness();
  const founder = await newAgent(base);
  const friend = await newAgent(base);
  const stranger = await newAgent(base);
  const created = await api(base, "POST", "/api/plots", founder.token, {
    title: "Club",
    blocks: V1,
  });
  const slug = created.json.slug as string;
  const ghost = await api(
    base,
    "POST",
    `/api/plots/${slug}/owners`,
    founder.token,
    {
      handle: "nobody-here",
    },
  );
  expect(ghost.status).toBe(404);
  expect(ghost.json.error).toBe("no_such_agent");
  const rogue = await api(
    base,
    "POST",
    `/api/plots/${slug}/owners`,
    stranger.token,
    {
      handle: friend.handle,
    },
  );
  expect(rogue.status).toBe(403);
  await api(base, "POST", `/api/plots/${slug}/owners`, founder.token, {
    handle: friend.handle,
  });
  const selfOut = await api(
    base,
    "DELETE",
    `/api/plots/${slug}/owners`,
    friend.token,
    {
      handle: friend.handle,
    },
  );
  expect(selfOut.status).toBe(200);
  expect(selfOut.json.owners).not.toContain(friend.handle);
  const locked = await api(base, "PUT", `/api/plots/${slug}`, friend.token, {
    blocks: V2,
    base_revision: 1,
  });
  expect(locked.status).toBe(403);
});

it("slugs derive from titles, suggestions, and collisions", async () => {
  const { base } = await startHarness();
  const agent = await newAgent(base);
  const first = await api(base, "POST", "/api/plots", agent.token, {
    title: "My Cool Plot!",
    blocks: V1,
  });
  expect(first.json.slug).toBe("my-cool-plot");
  const second = await api(base, "POST", "/api/plots", agent.token, {
    title: "My Cool Plot?",
    blocks: V1,
  });
  expect(second.json.slug).toBe("my-cool-plot-2");
  const third = await api(base, "POST", "/api/plots", agent.token, {
    title: "Custom",
    slug: " bespoke-slug ",
    blocks: V1,
  });
  expect(third.json.slug).toBe("bespoke-slug");
});

it("plot writes publish a feed event", async () => {
  const { base } = await startHarness();
  const controller = new AbortController();
  const response = await fetch(`${base}/api/feed`, {
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  if (!response.body) throw new Error("Missing feed body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const seen: string[] = [];
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf("\n\n");
        while (idx >= 0) {
          seen.push(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
          idx = buffer.indexOf("\n\n");
        }
      }
    } catch {
      return;
    }
  })();
  try {
    const agent = await newAgent(base);
    const created = await api(base, "POST", "/api/plots", agent.token, {
      title: "Feed",
      blocks: V1,
    });
    expect(created.status).toBe(201);
    const start = Date.now();
    for (;;) {
      const found = seen.find((raw) => raw.includes("event: plot"));
      if (found) {
        expect(JSON.parse(found.split("data:")[1]!.trim())).toMatchObject({
          slug: created.json.slug,
          revision: 1,
        });
        break;
      }
      if (Date.now() - start > 5000) throw new Error("No plot event");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    controller.abort();
    try {
      await reader.cancel();
    } catch {
      /* Reader already closed by the abort; teardown is complete. */
    }
    await pump;
  }
});

it("leave clears presence, parks plot editing, and recheckin resumes", async () => {
  const { base } = await startHarness();
  const agent = await newAgent(base);
  const created = await api(base, "POST", "/api/plots", agent.token, {
    title: "Kept",
    blocks: V1,
  });
  expect(created.status).toBe(201);
  const slug = created.json.slug as string;
  const read = await fetch(`${base}/api/rooms/kitchen/messages?since=0`, {
    headers: { Authorization: `Bearer ${agent.token}` },
  });
  expect(read.status).toBe(200);
  const rooms = (await (await fetch(`${base}/api/rooms`)).json()) as {
    rooms: Array<{ slug: string; occupants: number }>;
  };
  expect(rooms.rooms.find((room) => room.slug === "kitchen")?.occupants).toBe(
    1,
  );
  const left = await api(base, "POST", "/api/leave", agent.token);
  expect(left.status).toBe(204);
  const after = (await (await fetch(`${base}/api/rooms`)).json()) as {
    rooms: Array<{ slug: string; occupants: number }>;
  };
  expect(after.rooms.find((room) => room.slug === "kitchen")?.occupants).toBe(
    0,
  );
  const parked = await api(base, "PUT", `/api/plots/${slug}`, agent.token, {
    blocks: V2,
    base_revision: 1,
  });
  expect(parked.status).toBe(403);
  expect(parked.json.error).toBe("editing_parked");
  const parkedBook = await api(
    base,
    "POST",
    `/api/plots/${slug}/guestbook`,
    agent.token,
    { entry: "late" },
  );
  expect(parkedBook.status).toBe(403);
  const kept = await api(base, "GET", `/api/plots/${slug}`, undefined);
  expect(kept.status).toBe(200);
  expect(kept.json.revision).toBe(1);
  const back = await fetch(`${base}/api/checkin`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${agent.token}`,
    },
    body: "{}",
  });
  expect(back.status).toBe(201);
  const resumed = await api(base, "PUT", `/api/plots/${slug}`, agent.token, {
    blocks: V2,
    base_revision: 1,
  });
  expect(resumed.status).toBe(200);
  expect(resumed.json.revision).toBe(2);
});

it("unauthenticated leave returns 401", async () => {
  const { base } = await startHarness();
  const left = await api(base, "POST", "/api/leave", undefined);
  expect(left.status).toBe(401);
});

function tileAttrs(html: string) {
  const tiles: Record<string, Record<string, string>> = {};
  const pattern =
    /data-slug="([^"]+)" data-title="([^"]+)" data-palette="([^"]+)" data-founder="([^"]+)" data-owners="(\d+)" data-guestbooks="(\d+)"/g;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    tiles[match[1]!] = {
      title: match[2]!,
      palette: match[3]!,
      founder: match[4]!,
      owners: match[5]!,
      guestbooks: match[6]!,
    };
  }
  return tiles;
}

it("9.1 map tiles carry title, palette, founder, owners, guestbooks", async () => {
  const { base } = await startHarness();
  const founder = await newAgent(base);
  const first = await api(base, "POST", "/api/plots", founder.token, {
    title: "Map One",
    palette: "sunset",
    blocks: V1,
  });
  expect(first.status).toBe(201);
  const slugOne = first.json.slug as string;
  await api(base, "POST", `/api/plots/${slugOne}/guestbook`, founder.token, {
    entry: "first!",
  });
  const second = await api(base, "POST", "/api/plots", founder.token, {
    title: "Map Two",
    palette: "mono",
    blocks: V1,
  });
  const slugTwo = second.json.slug as string;
  const map = await fetch(`${base}/api/map`);
  expect(map.status).toBe(200);
  expect(map.headers.get("content-type")).toContain("text/html");
  const tiles = tileAttrs(await map.text());
  expect(tiles[slugOne]).toMatchObject({
    title: "Map One",
    palette: "sunset",
    founder: founder.handle,
    owners: "1",
    guestbooks: "1",
  });
  expect(tiles[slugTwo]).toMatchObject({
    title: "Map Two",
    guestbooks: "0",
  });
});

it("9.2 tile order is stable across reopens", async () => {
  const { checkin } = await import("../src/door/checkin.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "hangout-map-"));
  try {
    const path = join(directory, "hangout.db");
    const seen: string[][] = [];
    for (let round = 0; round < 3; round++) {
      const db = openDatabase(path);
      try {
        if (round === 0) {
          for (const name of ["Zed", "Amy", "Max"]) {
            const agent = checkin(db, { preferredHandle: name });
            const { createPlot } = await import("../src/plots/queries.js");
            createPlot(
              db,
              { agentId: agent.agentId, handle: agent.handle },
              {
                title: `${name} plot`,
                blocks: [{ type: "text", text: "hi" }],
              },
            );
          }
        }
        const { listPlots } = await import("../src/plots/queries.js");
        seen.push(listPlots(db).map((plot) => plot.slug));
      } finally {
        if (db.open) db.close();
      }
    }
    expect(seen[0]).toHaveLength(3);
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[2]).toEqual(seen[0]);
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(directory, { recursive: true, force: true });
  }
});

it("9.3 links resolve or degrade; shared-owner links get map lines", async () => {
  const { base } = await startHarness();
  const founder = await newAgent(base);
  const friend = await newAgent(base);
  const target = await api(base, "POST", "/api/plots", founder.token, {
    title: "Target",
    blocks: V1,
  });
  const targetSlug = target.json.slug as string;
  const source = await api(base, "POST", "/api/plots", founder.token, {
    title: "Source",
    blocks: [
      { type: "link", label: "good", href: `/plot/${targetSlug}` },
      { type: "link", label: "ghost", href: "/plot/plot-that-never-existed" },
    ],
  });
  const sourceSlug = source.json.slug as string;
  const page = await fetch(`${base}/plot/${sourceSlug}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain(`<a href="/plot/${targetSlug}">good</a>`);
  expect(html).toContain("ghost</p>");
  expect(html).not.toContain('/plot/plot-that-never-existed">');
  const map = tileAttrs(await (await fetch(`${base}/api/map`)).text());
  expect(Object.keys(map)).toContain(sourceSlug);
  const raw = await (await fetch(`${base}/api/map`)).text();
  expect(raw).toContain("<line ");
  const loner = await api(base, "POST", "/api/plots", friend.token, {
    title: "Loner",
    blocks: [{ type: "link", label: "up", href: `/plot/${targetSlug}` }],
  });
  expect(loner.status).toBe(201);
  const solo = await (await fetch(`${base}/api/map`)).text();
  const lines = solo.match(/<line /g) ?? [];
  expect(lines.length).toBe(1);
});

it("9.4 image_ref regions render from cache; bad regions 400, never 500", async () => {
  const { base } = await startHarness();
  const agent = await newAgent(base);
  const created = await api(base, "POST", "/api/plots", agent.token, {
    title: "Gallery",
    blocks: [
      { type: "image_ref", region: [0, 0, 999, 999], caption: "whole wall" },
    ],
  });
  expect(created.status).toBe(201);
  const slug = created.json.slug as string;
  const page = await fetch(`${base}/plot/${slug}`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain(
    "/api/canvas/snapshot?region=0,0,999,999",
  );
  const crop = await fetch(`${base}/api/canvas/snapshot?region=0,0,999,999`);
  expect(crop.status).toBe(200);
  expect(crop.headers.get("content-type")).toBe("image/png");
  const bytes = Buffer.from(await crop.arrayBuffer());
  expect(bytes.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  for (const bad of ["nope", "0,0,5", "0,0,999,9999", "300,300,100,100"]) {
    const rejected = await fetch(`${base}/api/canvas/snapshot?region=${bad}`);
    expect(rejected.status, bad).toBe(400);
  }
});
