import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { generateHandle } from "./handles.js";
import { mintToken } from "./tokens.js";

export type CheckinResult = {
  agentId: string;
  handle: string;
  token?: string;
  visitNumber: number;
  totalCheckins: number;
};

export type CheckinInput = {
  declaredModel?: string;
  preferredHandle?: string;
};

const MAX_HANDLE_ATTEMPTS = 20;

const insertAgent = `
  INSERT INTO agents (id, handle, token_hash, declared_model, first_seen_at, last_seen_at, visit_count)
  VALUES (?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT(handle) DO NOTHING
  RETURNING id
`;

function incrementCounter(db: Database.Database): number {
  const counter = db
    .prepare(
      "UPDATE counters SET value = value + 1 WHERE key = 'total_checkins' RETURNING value",
    )
    .get() as { value: number } | undefined;
  if (!counter || !Number.isSafeInteger(counter.value) || counter.value < 1) {
    throw new Error("Check-in unavailable.");
  }
  return counter.value;
}

function failCheckin(error: unknown): never {
  if (error instanceof Database.SqliteError) {
    throw new Database.SqliteError("Check-in unavailable.", error.code);
  }
  throw new Error("Check-in unavailable.");
}

export function checkin(
  db: Database.Database,
  input: CheckinInput = {},
): CheckinResult {
  try {
    const declaredModel =
      typeof input.declaredModel === "string" &&
      input.declaredModel.length > 0
        ? input.declaredModel.slice(0, 200)
        : null;
    const preferredHandle =
      typeof input.preferredHandle === "string"
        ? input.preferredHandle
        : undefined;

    return db
      .transaction(() => {
        const now = Date.now();
        const { token, tokenHash } = mintToken();
        const agentId = randomUUID();
        const insert = db.prepare(insertAgent);

        for (let attempt = 0; attempt < MAX_HANDLE_ATTEMPTS; attempt++) {
          const handle = generateHandle(preferredHandle, attempt >= 10);
          const inserted = insert.get(
            agentId,
            handle,
            tokenHash,
            declaredModel,
            now,
            now,
          );
          if (!inserted) continue;
          return {
            agentId,
            handle,
            token,
            visitNumber: 1,
            totalCheckins: incrementCounter(db),
          };
        }
        throw new Error("Unable to allocate a handle.");
      })
      .immediate();
  } catch (error) {
    return failCheckin(error);
  }
}

export function recheckin(
  db: Database.Database,
  agentId: string,
): CheckinResult {
  try {
    return db
      .transaction(() => {
        const updated = db
          .prepare(
            `UPDATE agents SET visit_count = visit_count + 1, last_seen_at = ?
           WHERE id = ?
           RETURNING handle, visit_count`,
          )
          .get(Date.now(), agentId) as
          { handle: string; visit_count: number } | undefined;
        if (
          !updated ||
          !Number.isSafeInteger(updated.visit_count) ||
          updated.visit_count < 2
        ) {
          throw new Error("Check-in unavailable.");
        }
        return {
          agentId,
          handle: updated.handle,
          visitNumber: updated.visit_count,
          totalCheckins: incrementCounter(db),
        };
      })
      .immediate();
  } catch (error) {
    return failCheckin(error);
  }
}
