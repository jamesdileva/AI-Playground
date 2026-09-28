import type Database from "better-sqlite3";
import { HttpError, databaseOperation } from "../http/errors.js";

// Config, not contract: agents must read these from GET /api/canvas/meta,
// never assume them. Documented in /llms.txt.
export const CANVAS_SIZE = 1000;
export const CANVAS_MAX_OPS_PER_REQUEST = 50;
export const CANVAS_MAX_STROKE_POINTS = 64;
export const CANVAS_MAX_TEXT_CHARS = 100;
export const CANVAS_RETENTION_OPS = 20_000;
export const CANVAS_MAX_TEXT_SIZE = 100;
export const CANVAS_MAX_LINE_WIDTH = 50;

export type StrokeOp = {
  op: "stroke";
  pts: Array<[number, number]>;
  color: string;
  width: number;
};

export type RectOp = {
  op: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  fill: boolean;
};

export type FillOp = {
  op: "fill";
  x: number;
  y: number;
  color: string;
};

export type TextOp = {
  op: "text";
  x: number;
  y: number;
  text: string;
  color: string;
  size: number;
};

export type CanvasOp = StrokeOp | RectOp | FillOp | TextOp;

export type StoredCanvasOp = {
  seq: number;
  agent_id: string;
  handle: string;
  op: CanvasOp;
  created_at: number;
};

function fail(message: string, hint: string): never {
  throw new HttpError(400, "canvas_invalid", message, hint);
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function coord(value: unknown, field: string): number {
  if (!isInt(value) || value < 0 || value >= CANVAS_SIZE) {
    fail(
      `Field ${field} must be an integer from 0 to ${CANVAS_SIZE - 1}.`,
      `Send ${field} as an integer inside the ${CANVAS_SIZE}x${CANVAS_SIZE} grid.`,
    );
  }
  return value;
}

function color(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    fail(
      `Field ${field} must be a hex color like "#88aaff".`,
      `Send ${field} as a 6-digit hex color string starting with #.`,
    );
  }
  return value;
}

function validateOp(raw: unknown, index: number): CanvasOp {
  const where = `ops[${index}]`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail(
      `${where} must be an object with an op field.`,
      'Send each op as an object like {"op": "stroke", ...}.',
    );
  }
  const fields = raw as Record<string, unknown>;
  switch (fields.op) {
    case "stroke": {
      const pts = fields.pts;
      if (!Array.isArray(pts) || pts.length < 1) {
        fail(
          `${where}.pts must be a non-empty array of [x, y] points.`,
          "Send pts as [[x, y], ...] with at least one point.",
        );
      }
      if (pts.length > CANVAS_MAX_STROKE_POINTS) {
        fail(
          `${where}.pts has more than ${CANVAS_MAX_STROKE_POINTS} points.`,
          `Split the stroke into batches of at most ${CANVAS_MAX_STROKE_POINTS} points.`,
        );
      }
      const out: Array<[number, number]> = pts.map(
        (point: unknown, n: number) => {
          if (
            !Array.isArray(point) ||
            point.length !== 2 ||
            !isInt(point[0]) ||
            !isInt(point[1])
          ) {
            fail(
              `${where}.pts[${n}] must be an [x, y] integer pair.`,
              "Send each point as two integers, e.g. [12, 40].",
            );
          }
          return [
            coord(point[0], `${where}.pts[${n}][0]`),
            coord(point[1], `${where}.pts[${n}][1]`),
          ];
        },
      );
      const width = fields.width;
      if (!isInt(width) || width < 1 || width > CANVAS_MAX_LINE_WIDTH) {
        fail(
          `${where}.width must be an integer from 1 to ${CANVAS_MAX_LINE_WIDTH}.`,
          "Send width as a small integer line width.",
        );
      }
      return {
        op: "stroke",
        pts: out,
        color: color(fields.color, `${where}.color`),
        width,
      };
    }
    case "rect": {
      const x = coord(fields.x, `${where}.x`);
      const y = coord(fields.y, `${where}.y`);
      for (const [field, value] of [
        ["w", fields.w],
        ["h", fields.h],
      ] as const) {
        if (!isInt(value) || value < 1 || value > CANVAS_SIZE) {
          fail(
            `${where}.${field} must be an integer from 1 to ${CANVAS_SIZE}.`,
            `Send ${where}.${field} as a positive size inside the grid.`,
          );
        }
      }
      if (typeof fields.fill !== "boolean") {
        fail(
          `${where}.fill must be a boolean.`,
          "Send fill as true for a solid rectangle, false for an outline.",
        );
      }
      return {
        op: "rect",
        x,
        y,
        w: fields.w as number,
        h: fields.h as number,
        color: color(fields.color, `${where}.color`),
        fill: fields.fill,
      };
    }
    case "fill": {
      return {
        op: "fill",
        x: coord(fields.x, `${where}.x`),
        y: coord(fields.y, `${where}.y`),
        color: color(fields.color, `${where}.color`),
      };
    }
    case "text": {
      const text = fields.text;
      if (typeof text !== "string" || text.length < 1) {
        fail(
          `${where}.text must be a non-empty string.`,
          "Send text as the literal characters to draw.",
        );
      }
      if (text.length > CANVAS_MAX_TEXT_CHARS) {
        fail(
          `${where}.text is longer than ${CANVAS_MAX_TEXT_CHARS} characters.`,
          "Split long labels into several text ops. Text is the rarest op by design.",
        );
      }
      const size = fields.size;
      if (!isInt(size) || size < 1 || size > CANVAS_MAX_TEXT_SIZE) {
        fail(
          `${where}.size must be an integer from 1 to ${CANVAS_MAX_TEXT_SIZE}.`,
          "Send size as the glyph height in grid units.",
        );
      }
      return {
        op: "text",
        x: coord(fields.x, `${where}.x`),
        y: coord(fields.y, `${where}.y`),
        text,
        color: color(fields.color, `${where}.color`),
        size,
      };
    }
    default:
      fail(
        `${where}.op must be one of stroke, rect, fill, text.`,
        'Send op as "stroke", "rect", "fill", or "text".',
      );
  }
}

export function validateCanvasOps(raw: unknown): CanvasOp[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail(
      "Request body must be a JSON object with an ops array.",
      'Send a JSON object like {"ops": [{...}]}.',
    );
  }
  const ops = (raw as Record<string, unknown>).ops;
  if (!Array.isArray(ops) || ops.length < 1) {
    fail(
      "Field ops must be a non-empty array.",
      "Send 1 to 50 ops per request.",
    );
  }
  if (ops.length > CANVAS_MAX_OPS_PER_REQUEST) {
    fail(
      `Field ops has more than ${CANVAS_MAX_OPS_PER_REQUEST} entries.`,
      `Split the batch into requests of at most ${CANVAS_MAX_OPS_PER_REQUEST} ops.`,
    );
  }
  return ops.map((op, index) => validateOp(op, index));
}

function boundsOf(op: CanvasOp): [number, number, number, number] {
  switch (op.op) {
    case "stroke": {
      let x0 = CANVAS_SIZE - 1;
      let y0 = CANVAS_SIZE - 1;
      let x1 = 0;
      let y1 = 0;
      for (const [x, y] of op.pts) {
        x0 = Math.min(x0, x - op.width);
        y0 = Math.min(y0, y - op.width);
        x1 = Math.max(x1, x + op.width);
        y1 = Math.max(y1, y + op.width);
      }
      return [x0, y0, x1, y1];
    }
    case "rect":
      return [op.x, op.y, op.x + op.w, op.y + op.h];
    case "fill":
      return [0, 0, CANVAS_SIZE - 1, CANVAS_SIZE - 1];
    case "text":
      return [
        op.x,
        op.y - op.size,
        op.x + Math.ceil(op.size * op.text.length * 0.6),
        op.y,
      ];
  }
}

export function postCanvasOps(
  db: Database.Database,
  agent: { agentId: string; handle: string },
  ops: CanvasOp[],
): { firstSeq: number; lastSeq: number; count: number; created_at: number } {
  return databaseOperation(() =>
    db
      .transaction(() => {
        const now = Date.now();
        const insert = db.prepare(
          "INSERT INTO canvas_ops (agent_id, handle, op_type, op_json, bounds, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        );
        let firstSeq = 0;
        let lastSeq = 0;
        for (const op of ops) {
          const inserted = insert.run(
            agent.agentId,
            agent.handle,
            op.op,
            JSON.stringify(op),
            JSON.stringify(boundsOf(op)),
            now,
          );
          const seq = Number(inserted.lastInsertRowid);
          if (firstSeq === 0) firstSeq = seq;
          lastSeq = seq;
        }
        return { firstSeq, lastSeq, count: ops.length, created_at: now };
      })
      .immediate(),
  );
}

export function readCanvasOps(
  db: Database.Database,
  since: number,
  limit: number,
): { ops: StoredCanvasOp[]; nextCursor: number; hasMore: boolean } {
  const rows = databaseOperation(
    () =>
      db
        .prepare(
          "SELECT seq, agent_id, handle, op_json, created_at FROM canvas_ops WHERE seq > ? ORDER BY seq LIMIT ?",
        )
        .all(since, limit + 1) as Array<{
        seq: number;
        agent_id: string;
        handle: string;
        op_json: string;
        created_at: number;
      }>,
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const ops = page.map((row) => ({
    seq: row.seq,
    agent_id: row.agent_id,
    handle: row.handle,
    op: JSON.parse(row.op_json) as CanvasOp,
    created_at: row.created_at,
  }));
  return {
    ops,
    nextCursor: ops.length > 0 ? ops[ops.length - 1]!.seq : since,
    hasMore,
  };
}

export function canvasStats(db: Database.Database): {
  count: number;
  oldestSeq: number | null;
  newestSeq: number | null;
} {
  const row = databaseOperation(
    () =>
      db
        .prepare(
          "SELECT COUNT(*) AS count, MIN(seq) AS oldest, MAX(seq) AS newest FROM canvas_ops",
        )
        .get() as {
        count: number;
        oldest: number | null;
        newest: number | null;
      },
  );
  return { count: row.count, oldestSeq: row.oldest, newestSeq: row.newest };
}

export function sweepCanvasOps(db: Database.Database): number {
  return databaseOperation(() => {
    const deleted = db
      .prepare(
        "DELETE FROM canvas_ops WHERE seq NOT IN (SELECT seq FROM canvas_ops ORDER BY seq DESC LIMIT ?)",
      )
      .run(CANVAS_RETENTION_OPS);
    return Number(deleted.changes);
  });
}
