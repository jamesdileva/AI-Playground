import type { MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { HttpError } from "./errors.js";

export type ThrottleOptions = {
  limit?: number;
  now?: () => number;
  maxTrackedKeys?: number;
  trustProxy?: boolean;
};

export function ipThrottle(options: ThrottleOptions = {}): MiddlewareHandler {
  const buckets = new Map<string, number[]>();
  const maxKeys = options.maxTrackedKeys ?? 10_000;
  const limit = options.limit ?? 10;
  const clock = options.now ?? Date.now;
  const trustProxy = options.trustProxy ?? false;
  return async (c, next) => {
    const forwarded = trustProxy
      ? (c.req.header("CF-Connecting-IP") ??
        c.req.header("X-Forwarded-For")?.split(",")[0]?.trim())
      : undefined;
    const address =
      (forwarded && forwarded.length > 0
        ? forwarded.slice(0, 45)
        : getConnInfo(c).remote.address) ?? undefined;
    if (!address)
      throw new HttpError(
        503,
        "unavailable",
        "Client address unavailable.",
        "Retry in 5 seconds.",
        5,
      );
    const key = address.replace(/^::ffff:/, "");
    const now = clock();
    for (const [ip, times] of buckets) {
      const active = times.filter((time) => now - time < 60_000);
      if (active.length) buckets.set(ip, active);
      else buckets.delete(ip);
    }
    const times = buckets.get(key) ?? [];
    if (times.length >= limit) {
      throw new HttpError(
        429,
        "checkin_throttle",
        "Too many check-ins from this address.",
        "Wait retry_after seconds before checking in again.",
        Math.max(1, Math.ceil((times[0]! + 60_000 - now) / 1000)),
      );
    }
    if (!buckets.has(key) && buckets.size >= maxKeys) {
      throw new HttpError(
        503,
        "unavailable",
        "Check-in capacity reached.",
        "Retry in 60 seconds.",
        60,
      );
    }
    times.push(now);
    buckets.set(key, times);
    await next();
  };
}
