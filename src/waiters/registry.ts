export type WaitOutcome = "woke" | "timeout" | "aborted";

export function createWaiters() {
  const rooms = new Map<number, Set<() => void>>();

  function count(roomId?: number): number {
    if (roomId !== undefined) return rooms.get(roomId)?.size ?? 0;
    let total = 0;
    for (const waiters of rooms.values()) total += waiters.size;
    return total;
  }

  function wake(roomId: number): void {
    const waiters = rooms.get(roomId);
    if (!waiters) return;
    rooms.delete(roomId);
    for (const resolve of waiters) resolve();
  }

  function wait(
    roomId: number,
    timeoutMs: number,
    signal?: AbortSignal | null,
  ): Promise<WaitOutcome> {
    return new Promise<WaitOutcome>((resolve) => {
      let waiters = rooms.get(roomId);
      if (!waiters) {
        waiters = new Set();
        rooms.set(roomId, waiters);
      }
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const remaining = rooms.get(roomId);
        if (remaining) {
          remaining.delete(done);
          if (remaining.size === 0) rooms.delete(roomId);
        }
      };
      const done = () => {
        cleanup();
        resolve("woke");
      };
      const onTimeout = () => {
        cleanup();
        resolve("timeout");
      };
      const onAbort = () => {
        cleanup();
        resolve("aborted");
      };
      waiters.add(done);
      const timer = setTimeout(onTimeout, timeoutMs);
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  return { count, wake, wait };
}

export type Waiters = ReturnType<typeof createWaiters>;
