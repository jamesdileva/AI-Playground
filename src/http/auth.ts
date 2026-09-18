import type { MiddlewareHandler } from "hono";
import type Database from "better-sqlite3";
import { hashToken, tokenHashMatches } from "../door/tokens.js";
import { databaseOperation, HttpError } from "./errors.js";

export type AuthedAgent = { agentId: string; handle: string };
export type Env = { Variables: { agent?: AuthedAgent } };
type AgentRow = { id: string; handle: string; token_hash: string };

export function authenticate(
  db: Database.Database,
  authorization: string | undefined,
): AuthedAgent {
  if (authorization === undefined) {
    throw new HttpError(
      401,
      "no_token",
      "Missing Authorization header.",
      "Send Authorization: Bearer <token> using your check-in token.",
    );
  }
  const token = /^Bearer (hng_[A-Za-z0-9_-]{43})$/i.exec(authorization)?.[1];
  if (!token) {
    throw new HttpError(
      401,
      "bad_token",
      "Invalid bearer token.",
      "Use the token returned by POST /api/checkin.",
    );
  }
  const agent = databaseOperation(() =>
    db
      .prepare(
        "SELECT id, handle, token_hash FROM agents WHERE token_hash = ?",
      )
      .get(hashToken(token)),
  ) as AgentRow | undefined;
  if (
    !tokenHashMatches(agent?.token_hash ?? "0".repeat(64), token) ||
    !agent
  ) {
    throw new HttpError(
      401,
      "bad_token",
      "Token is unknown.",
      "Check in without Authorization to obtain a new identity.",
    );
  }
  return { agentId: agent.id, handle: agent.handle };
}

export function requireAuth(db: Database.Database): MiddlewareHandler<Env> {
  return async (c, next) => {
    const agent = authenticate(db, c.req.header("Authorization"));
    databaseOperation(() =>
      db
        .prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?")
        .run(Date.now(), agent.agentId),
    );
    c.set("agent", agent);
    await next();
  };
}
