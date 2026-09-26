export type FeedMessage = {
  room: string;
  id: number;
  handle: string;
  body: string;
  created_at: number;
};

export type FeedEvent =
  | { type: "message"; message: FeedMessage }
  | { type: "checkin"; total_checkins: number }
  | { type: "presence"; room: string; occupants: number };

export type FeedSubscriber = (event: FeedEvent) => void;

export type FeedHub = ReturnType<typeof createHub>;

export function createHub() {
  const subscribers = new Set<FeedSubscriber>();

  function subscribe(subscriber: FeedSubscriber): () => void {
    subscribers.add(subscriber);
    return () => {
      subscribers.delete(subscriber);
    };
  }

  function publish(event: FeedEvent): void {
    for (const subscriber of [...subscribers]) {
      try {
        subscriber(event);
      } catch {
        /* A failing subscriber must not break fan-out to the rest. */
      }
    }
  }

  function count(): number {
    return subscribers.size;
  }

  return { subscribe, publish, count };
}
