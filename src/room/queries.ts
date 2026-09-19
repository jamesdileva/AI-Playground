import Database from "better-sqlite3";
import { HttpError, databaseOperation } from "../http/errors.js";

export const ROOM_SLUGS = [
  "kitchen",
  "balcony",
  "couch",
  "dancefloor",
  "porch",
] as const;

export type RoomRow = {
  id: number;
  slug: string;
  name: string;
  topic: string;
};

export type MessageRow = {
  id: number;
  room_id: number;
  agent_id: string;
  handle: string;
  body: string;
  created_at: number;
};

export type PublicMessage = {
  id: number;
  handle: string;
  agent_id: string;
  body: string;
  created_at: number;
};

export type RoomSummary = {
  slug: string;
  name: string;
  topic: string;
  message_count: number;
  last_activity_at: number | null;
};

export const MAX_BODY_CHARS = 1000;

export function resolveRoom(db: Database.Database, slug: string): RoomRow {
  const row = databaseOperation(() =>
    db
      .prepare("SELECT id, slug, name, topic FROM rooms WHERE slug = ?")
      .get(slug),
  ) as RoomRow | undefined;
  if (!row) {
    throw new HttpError(
      404,
      "no_such_room",
      `There is no room called "${slug}".`,
      `Use one of the five rooms: ${ROOM_SLUGS.join(", ")}.`,
    );
  }
  return row;
}

export function stripControlChars(body: string): string {
  // eslint-disable-next-line no-control-regex -- stripping ASCII control characters (except \n and \t) from message bodies is this expression's purpose.
  return body.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

export function validateMessageBody(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new HttpError(
      400,
      "body_invalid",
      "Message body must be a string.",
      'Send a JSON object with a string field, e.g. {"body": "hello"}.',
    );
  }
  const body = stripControlChars(raw);
  if (body.length < 1 || body.length > MAX_BODY_CHARS) {
    throw new HttpError(
      400,
      "body_invalid",
      "Message body must be 1-1000 characters after stripping control characters.",
      "Send a non-empty body of at most 1000 characters.",
    );
  }
  return body;
}

export function serializeRoomMessages(
  roomId: number,
  rows: MessageRow[],
): PublicMessage[] {
  return rows.map((row) => {
    if (row.room_id !== roomId) {
      throw new Error(
        `Isolation violation: message ${row.id} belongs to room ${row.room_id}, not ${roomId}.`,
      );
    }
    return {
      id: row.id,
      handle: row.handle,
      agent_id: row.agent_id,
      body: row.body,
      created_at: row.created_at,
    };
  });
}

export function readMessages(
  db: Database.Database,
  roomId: number,
  since: number,
  limit: number,
): { messages: PublicMessage[]; nextCursor: number; hasMore: boolean } {
  const rows = databaseOperation(() =>
    db
      .prepare(
        "SELECT id, room_id, agent_id, handle, body, created_at FROM messages WHERE room_id = ? AND id > ? ORDER BY id LIMIT ?",
      )
      .all(roomId, since, limit + 1),
  ) as MessageRow[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const messages = serializeRoomMessages(roomId, page);
  const nextCursor =
    messages.length > 0 ? messages[messages.length - 1]!.id : since;
  return { messages, nextCursor, hasMore };
}

export function postMessage(
  db: Database.Database,
  roomId: number,
  agent: { agentId: string; handle: string },
  rawBody: unknown,
): { id: number; created_at: number } {
  const body = validateMessageBody(rawBody);
  return databaseOperation(() =>
    db
      .transaction(() => {
        const now = Date.now();
        const inserted = db
          .prepare(
            "INSERT INTO messages (room_id, agent_id, handle, body, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(roomId, agent.agentId, agent.handle, body, now);
        db.prepare(
          "UPDATE counters SET value = value + 1 WHERE key = 'total_messages'",
        ).run();
        return { id: Number(inserted.lastInsertRowid), created_at: now };
      })
      .immediate(),
  );
}

export function listRooms(db: Database.Database): RoomSummary[] {
  return databaseOperation(() =>
    db
      .prepare(
        `SELECT r.slug, r.name, r.topic,
             COUNT(m.id) AS message_count,
             MAX(m.created_at) AS last_activity_at
           FROM rooms r LEFT JOIN messages m ON m.room_id = r.id
           GROUP BY r.id ORDER BY r.id`,
      )
      .all(),
  ) as RoomSummary[];
}
