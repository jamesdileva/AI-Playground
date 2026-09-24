export type MessageLimits = {
  cooldownMs: number;
  hourlyCap: number;
};

export const DEFAULT_MESSAGE_LIMITS: MessageLimits = {
  cooldownMs: 8000,
  hourlyCap: 60,
};

export const RELAXED_MESSAGE_LIMITS: MessageLimits = {
  cooldownMs: 0,
  hourlyCap: 1_000_000,
};

export type LimitVerdict =
  | { ok: true }
  | { ok: false; code: "cooldown" | "hourly_cap"; retryAfter: number };

const HOUR_MS = 3_600_000;
const MAX_AGENTS = 10_000;

export function createMessageLimiter(
  now: () => number = Date.now,
  limits: MessageLimits = DEFAULT_MESSAGE_LIMITS,
) {
  const lastPost = new Map<string, number>();
  const hourly = new Map<string, number[]>();

  function evict(key: string, map: Map<string, unknown>): void {
    if (!map.has(key) && map.size >= MAX_AGENTS) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }

  function check(
    roomId: number,
    agentId: string,
    cooldownMs: number = limits.cooldownMs,
  ): LimitVerdict {
    const timestamp = now();
    const recent = (hourly.get(agentId) ?? []).filter(
      (posted) => timestamp - posted < HOUR_MS,
    );
    hourly.set(agentId, recent);
    if (recent.length >= limits.hourlyCap) {
      return {
        ok: false,
        code: "hourly_cap",
        retryAfter: Math.max(
          1,
          Math.ceil((recent[0]! + HOUR_MS - timestamp) / 1000),
        ),
      };
    }
    const last = lastPost.get(`${agentId}:${roomId}`);
    if (last !== undefined && timestamp - last < cooldownMs) {
      return {
        ok: false,
        code: "cooldown",
        retryAfter: Math.max(
          1,
          Math.ceil((last + cooldownMs - timestamp) / 1000),
        ),
      };
    }
    return { ok: true };
  }

  function record(roomId: number, agentId: string): void {
    const timestamp = now();
    evict(`${agentId}:${roomId}`, lastPost);
    evict(agentId, hourly);
    lastPost.set(`${agentId}:${roomId}`, timestamp);
    const recent = hourly.get(agentId) ?? [];
    recent.push(timestamp);
    hourly.set(agentId, recent);
  }

  return { check, record };
}

export type MessageLimiter = ReturnType<typeof createMessageLimiter>;
