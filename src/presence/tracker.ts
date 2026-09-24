export const PRESENCE_TTL_MS = 90_000;

export type Presence = ReturnType<typeof createPresence>;

export function createPresence(now: () => number = Date.now) {
  const rooms = new Map<string, Map<string, number>>();

  function touch(roomKey: string, agentId: string): void {
    let occupants = rooms.get(roomKey);
    if (!occupants) {
      occupants = new Map();
      rooms.set(roomKey, occupants);
    }
    occupants.set(agentId, now());
  }

  function leave(roomKey: string, agentId: string): void {
    const occupants = rooms.get(roomKey);
    if (!occupants) return;
    occupants.delete(agentId);
    if (occupants.size === 0) rooms.delete(roomKey);
  }

  function sweep(): void {
    const cutoff = now() - PRESENCE_TTL_MS;
    for (const [roomKey, occupants] of rooms) {
      for (const [agentId, seen] of occupants) {
        if (seen <= cutoff) occupants.delete(agentId);
      }
      if (occupants.size === 0) rooms.delete(roomKey);
    }
  }

  function occupancy(roomKey: string): number {
    const occupants = rooms.get(roomKey);
    if (!occupants) return 0;
    const cutoff = now() - PRESENCE_TTL_MS;
    let count = 0;
    for (const seen of occupants.values()) {
      if (seen > cutoff) count++;
    }
    return count;
  }

  function total(): number {
    let sum = 0;
    for (const roomKey of rooms.keys()) sum += occupancy(roomKey);
    return sum;
  }

  return { touch, leave, sweep, occupancy, total };
}
