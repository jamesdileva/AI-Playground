/* 4.9 gate check: Lighthouse performance >= 95 (desktop) against a fresh
 * compiled server, driven through Playwright's bundled Chromium. */
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import testPkg from "@playwright/test";
import lighthouse from "lighthouse";

const { chromium } = testPkg;

const PORT = 3211;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = "hangout.perf.db";
const DEBUG_PORT = 9333;
const MIN_SCORE = 0.95;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    await rm(`${DB}${suffix}`, { force: true });
  }
  const server = spawn(
    process.execPath,
    ["dist/server.js"],
    {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, PORT: String(PORT), DB_PATH: DB },
      stdio: "ignore",
    },
  );
  try {
    let healthy = false;
    for (let i = 0; i < 40 && !healthy; i++) {
      await sleep(500);
      try {
        const res = await fetch(`${BASE}/api/health`);
        healthy = res.ok;
      } catch {
        healthy = false;
      }
    }
    if (!healthy) throw new Error("perf server did not start");

    const browser = await chromium.launch({
      args: [`--remote-debugging-port=${DEBUG_PORT}`],
    });
    try {
      const result = await lighthouse(
        `${BASE}/`,
        {
          port: DEBUG_PORT,
          preset: "desktop",
          onlyCategories: ["performance"],
          logLevel: "error",
        },
        undefined,
      );
      if (!result) throw new Error("lighthouse returned nothing");
      const score = result.lhr.categories.performance.score ?? 0;
      const metrics = result.lhr.audits.metrics?.details?.items?.[0] ?? {};
      console.log(
        JSON.stringify({
          performance: score,
          firstContentfulPaintMs: metrics.firstContentfulPaint,
          largestContentfulPaintMs: metrics.largestContentfulPaint,
          totalBlockingTimeMs: metrics.totalBlockingTime,
          cumulativeLayoutShift: metrics.cumulativeLayoutShift,
          speedIndexMs: metrics.speedIndex,
        }),
      );
      if (score < MIN_SCORE) {
        throw new Error(`performance ${score} below ${MIN_SCORE}`);
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.kill();
  }
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    await rm(`${DB}${suffix}`, { force: true }).catch(() => {});
  }
}

await main();
