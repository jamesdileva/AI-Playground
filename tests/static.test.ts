import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { createApp } from "../src/http/app.js";

it("serves the spectator page with exact content types", async () => {
  const db = openDatabase(":memory:");
  try {
    const app = createApp(db, () => {}, { sweepers: false });
    const page = await app.request("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const html = await page.text();
    expect(html).toContain('id="rooms"');
    for (const slug of [
      "kitchen",
      "balcony",
      "couch",
      "dancefloor",
      "porch",
    ]) {
      expect(html).toContain(`data-room="${slug}"`);
    }
    const js = await app.request("/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    const css = await app.request("/style.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect((await app.request("/admin")).status).toBe(404);
    expect((await app.request("/app.js.map")).status).toBe(404);
  } finally {
    if (db.open) db.close();
  }
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
