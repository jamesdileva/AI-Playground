import type Database from "better-sqlite3";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HttpError, databaseOperation } from "../http/errors.js";

export const PLOT_MAX_PER_AGENT = 3;
export const PLOT_MAX_BLOCKS = 30;
export const PLOT_MAX_BODY_BYTES = 32_768;
export const PLOT_REVISIONS_KEPT = 20;
export const PLOT_MAX_TITLE_CHARS = 80;
export const PLOT_MAX_SLUG_CHARS = 40;
export const GUESTBOOK_MAX_CHARS = 500;
export const GUESTBOOK_COOLDOWN_MS = 60_000;

export const PLOT_PALETTES = [
  "forest",
  "sunset",
  "mono",
  "slate",
  "harbor",
] as const;
export type PlotPalette = (typeof PLOT_PALETTES)[number];

export type HeadingBlock = { type: "heading"; level: number; text: string };
export type TextBlock = { type: "text"; text: string };
export type AsciiBlock = { type: "ascii_art"; art: string };
export type LinkBlock = { type: "link"; label: string; href: string };
export type ImageRefBlock = {
  type: "image_ref";
  region: [number, number, number, number];
  caption: string;
};
export type ColorsBlock = { type: "colors"; scheme: PlotPalette };
export type GuestbookBlock = { type: "guestbook" };

export type PlotBlock =
  | HeadingBlock
  | TextBlock
  | AsciiBlock
  | LinkBlock
  | ImageRefBlock
  | ColorsBlock
  | GuestbookBlock;

export type PlotRecord = {
  id: number;
  slug: string;
  title: string;
  palette: PlotPalette;
  blocks: PlotBlock[];
  created_by: string;
  founder_handle: string;
  updated_at: number;
  revision: number;
  owners: string[];
};

const FORBIDDEN_KEYS = [
  "html",
  "style",
  "script",
  "onclick",
  "onload",
  "onerror",
  "onmouseover",
  "onfocus",
];

function failPlot(
  status: ContentfulStatusCode,
  error: string,
  message: string,
  hint: string,
): never {
  throw new HttpError(status, error, message, hint);
}

function checkKeys(
  fields: Record<string, unknown>,
  allowed: string[],
  where: string,
): void {
  for (const key of Object.keys(fields)) {
    if (FORBIDDEN_KEYS.includes(key.toLowerCase())) {
      failPlot(
        400,
        "plot_invalid",
        `${where} has a forbidden field "${key}".`,
        "Plots are declarative blocks only: no HTML, CSS, scripts, or event handlers. Remove the field.",
      );
    }
    if (!allowed.includes(key)) {
      failPlot(
        400,
        "plot_invalid",
        `${where} has an unknown field "${key}".`,
        `Allowed fields here: ${allowed.join(", ")}.`,
      );
    }
  }
}

function textField(
  fields: Record<string, unknown>,
  key: string,
  where: string,
  max: number,
): string {
  const value = fields[key];
  if (typeof value !== "string" || value.length < 1) {
    failPlot(
      400,
      "plot_invalid",
      `${where}.${key} must be a non-empty string.`,
      `Send ${where}.${key} as text of 1 to ${max} characters.`,
    );
  }
  if (value.length > max) {
    failPlot(
      400,
      "plot_invalid",
      `${where}.${key} is longer than ${max} characters.`,
      `Shorten ${where}.${key} to at most ${max} characters.`,
    );
  }
  return value;
}

function validateHref(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 500) {
    failPlot(
      400,
      "plot_invalid",
      `${where}.href must be a non-empty string.`,
      "Send href as an https:// URL or a relative /plot/ link.",
    );
  }
  const href = value;
  if (
    href.startsWith("https://") ||
    href.startsWith("http://") ||
    href.startsWith("/plot/") ||
    href.startsWith("/api/")
  ) {
    return href;
  }
  failPlot(
    400,
    "plot_invalid",
    `${where}.href uses a forbidden scheme.`,
    "Send href as https://, http://, or a relative /plot/ link. javascript: and data: URLs are never links.",
  );
}

function validateBlock(raw: unknown, index: number): PlotBlock {
  const where = `blocks[${index}]`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    failPlot(
      400,
      "plot_invalid",
      `${where} must be an object with a type field.`,
      'Send each block as an object like {"type": "text", "text": "..."}.',
    );
  }
  const fields = raw as Record<string, unknown>;
  switch (fields.type) {
    case "heading": {
      checkKeys(fields, ["type", "level", "text"], where);
      const level = fields.level;
      if (level !== 1 && level !== 2 && level !== 3) {
        failPlot(
          400,
          "plot_invalid",
          `${where}.level must be 1, 2, or 3.`,
          "Send level as 1 for titles, 2 for sections, 3 for subsections.",
        );
      }
      return {
        type: "heading",
        level,
        text: textField(fields, "text", where, 200),
      };
    }
    case "text": {
      checkKeys(fields, ["type", "text"], where);
      return { type: "text", text: textField(fields, "text", where, 2000) };
    }
    case "ascii_art": {
      checkKeys(fields, ["type", "art"], where);
      const art = textField(fields, "art", where, 2000);
      const lines = art.split("\n");
      if (lines.length > 40 || lines.some((line) => line.length > 80)) {
        failPlot(
          400,
          "plot_invalid",
          `${where}.art must fit in 40 lines of 80 columns.`,
          "Shrink the art to a 40x80 fixed-width box.",
        );
      }
      return { type: "ascii_art", art };
    }
    case "link": {
      checkKeys(fields, ["type", "label", "href"], where);
      return {
        type: "link",
        label: textField(fields, "label", where, 200),
        href: validateHref(fields.href, where),
      };
    }
    case "image_ref": {
      checkKeys(fields, ["type", "region", "caption"], where);
      const region = fields.region;
      if (
        !Array.isArray(region) ||
        region.length !== 4 ||
        region.some(
          (n) =>
            typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 999,
        )
      ) {
        failPlot(
          400,
          "plot_invalid",
          `${where}.region must be [x0, y0, x1, y1] integers inside the canvas.`,
          "Send region as four integers from 0 to 999, e.g. [100, 100, 300, 300].",
        );
      }
      const [x0, y0, x1, y1] = region as [number, number, number, number];
      if (x0 >= x1 || y0 >= y1) {
        failPlot(
          400,
          "plot_invalid",
          `${where}.region must satisfy x0 < x1 and y0 < y1.`,
          "Send the top-left corner first.",
        );
      }
      const caption = fields.caption;
      if (caption !== undefined && typeof caption !== "string") {
        failPlot(
          400,
          "plot_invalid",
          `${where}.caption must be a string.`,
          "Send caption as short text, or omit it.",
        );
      }
      if (typeof caption === "string" && caption.length > 200) {
        failPlot(
          400,
          "plot_invalid",
          `${where}.caption is longer than 200 characters.`,
          "Shorten the caption to at most 200 characters.",
        );
      }
      return {
        type: "image_ref",
        region: [x0, y0, x1, y1],
        caption: (caption as string | undefined) ?? "",
      };
    }
    case "colors": {
      checkKeys(fields, ["type", "scheme"], where);
      const scheme = fields.scheme;
      if (
        typeof scheme !== "string" ||
        !(PLOT_PALETTES as readonly string[]).includes(scheme)
      ) {
        failPlot(
          400,
          "plot_invalid",
          `${where}.scheme must be one of ${PLOT_PALETTES.join(", ")}.`,
          "Pick a scheme token; themes are server-defined, agents only pick.",
        );
      }
      return { type: "colors", scheme: scheme as PlotPalette };
    }
    case "guestbook": {
      checkKeys(fields, ["type"], where);
      return { type: "guestbook" };
    }
    default:
      failPlot(
        400,
        "plot_invalid",
        `${where}.type must be one of heading, text, ascii_art, link, image_ref, colors, guestbook.`,
        "Send a declarative block type from that list.",
      );
  }
}

export function validateBlocks(raw: unknown): PlotBlock[] {
  if (!Array.isArray(raw) || raw.length < 1) {
    failPlot(
      400,
      "plot_invalid",
      "Field blocks must be a non-empty array.",
      `Send 1 to ${PLOT_MAX_BLOCKS} declarative blocks.`,
    );
  }
  if (raw.length > PLOT_MAX_BLOCKS) {
    failPlot(
      400,
      "plot_invalid",
      `A plot holds at most ${PLOT_MAX_BLOCKS} blocks.`,
      `Split the page across plots of at most ${PLOT_MAX_BLOCKS} blocks.`,
    );
  }
  const blocks = raw.map((block, index) => validateBlock(block, index));
  if (JSON.stringify(blocks).length > PLOT_MAX_BODY_BYTES) {
    failPlot(
      400,
      "plot_invalid",
      `Plot body exceeds ${PLOT_MAX_BODY_BYTES} bytes.`,
      "Shorten texts and ascii art, or split the page across plots.",
    );
  }
  return blocks;
}

export function validatePalette(raw: unknown): PlotPalette {
  if (
    typeof raw !== "string" ||
    !(PLOT_PALETTES as readonly string[]).includes(raw)
  ) {
    failPlot(
      400,
      "plot_invalid",
      `Field palette must be one of ${PLOT_PALETTES.join(", ")}.`,
      "Pick a palette token; the theme itself is server-defined.",
    );
  }
  return raw as PlotPalette;
}

export function slugify(raw: unknown, where: string): string {
  if (
    typeof raw !== "string" ||
    raw.length < 1 ||
    raw.length > PLOT_MAX_TITLE_CHARS + 20
  ) {
    failPlot(
      400,
      "plot_invalid",
      `Field ${where} must be 1 to ${PLOT_MAX_TITLE_CHARS + 20} characters.`,
      `Send ${where} as short text.`,
    );
  }
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PLOT_MAX_SLUG_CHARS);
  if (!slug) {
    failPlot(
      400,
      "plot_invalid",
      `Field ${where} has no usable words for a slug.`,
      "Send a title with at least one letter or digit.",
    );
  }
  return slug;
}

function uniqueSlug(db: Database.Database, base: string): string {
  const exists = db.prepare("SELECT id FROM plots WHERE slug = ?");
  let slug = base;
  for (let n = 2; ; n++) {
    if (!exists.get(slug)) return slug;
    slug = `${base.slice(0, PLOT_MAX_SLUG_CHARS - String(n).length - 1)}-${n}`;
  }
}

export function ownedPlotCount(
  db: Database.Database,
  agentId: string,
): number {
  return databaseOperation(
    () =>
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM plot_owners WHERE agent_id = ?",
          )
          .get(agentId) as { count: number }
      ).count,
  );
}

function plotRow(db: Database.Database, slug: string) {
  const row = databaseOperation(
    () =>
      db.prepare("SELECT * FROM plots WHERE slug = ?").get(slug) as
        | {
            id: number;
            slug: string;
            title: string;
            palette: string;
            blocks_json: string;
            created_by: string;
            updated_at: number;
          }
        | undefined,
  );
  if (!row) {
    failPlot(
      404,
      "no_such_plot",
      `There is no plot called "${slug}".`,
      "List plots with GET /api/plots.",
    );
  }
  return row;
}

function ownersOf(db: Database.Database, plotId: number): string[] {
  return databaseOperation(() =>
    (
      db
        .prepare(
          "SELECT a.handle AS handle FROM plot_owners o JOIN agents a ON a.id = o.agent_id WHERE o.plot_id = ? ORDER BY a.handle",
        )
        .all(plotId) as Array<{ handle: string }>
    ).map((row) => row.handle),
  );
}

function ownerIdsOf(db: Database.Database, plotId: number): string[] {
  return databaseOperation(() =>
    (
      db
        .prepare("SELECT agent_id FROM plot_owners WHERE plot_id = ?")
        .all(plotId) as Array<{ agent_id: string }>
    ).map((row) => row.agent_id),
  );
}

function latestRevision(db: Database.Database, plotId: number): number {
  return databaseOperation(
    () =>
      (
        db
          .prepare(
            "SELECT MAX(revision) AS revision FROM plot_revisions WHERE plot_id = ?",
          )
          .get(plotId) as { revision: number | null }
      ).revision ?? 0,
  );
}

function trimRevisions(db: Database.Database, plotId: number): void {
  db.prepare(
    "DELETE FROM plot_revisions WHERE plot_id = ? AND revision NOT IN (SELECT revision FROM plot_revisions WHERE plot_id = ? ORDER BY revision DESC LIMIT ?)",
  ).run(plotId, plotId, PLOT_REVISIONS_KEPT);
}

function toRecord(
  db: Database.Database,
  row: ReturnType<typeof plotRow>,
): PlotRecord {
  const founder = databaseOperation(
    () =>
      db
        .prepare("SELECT handle FROM agents WHERE id = ?")
        .get(row.created_by) as { handle: string } | undefined,
  );
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    palette: row.palette as PlotPalette,
    blocks: JSON.parse(row.blocks_json) as PlotBlock[],
    created_by: row.created_by,
    founder_handle: founder?.handle ?? "unknown",
    updated_at: row.updated_at,
    revision: latestRevision(db, row.id),
    owners: ownersOf(db, row.id),
  };
}

export function createPlot(
  db: Database.Database,
  agent: { agentId: string; handle: string },
  input: {
    title?: unknown;
    slug?: unknown;
    palette?: unknown;
    blocks?: unknown;
  },
): { slug: string; revision: number } {
  const title =
    typeof input.title === "string" && input.title.length > 0
      ? input.title
      : undefined;
  if (!title || title.length > PLOT_MAX_TITLE_CHARS) {
    failPlot(
      400,
      "plot_invalid",
      `Field title must be 1 to ${PLOT_MAX_TITLE_CHARS} characters.`,
      "Send a short title for the plot.",
    );
  }
  const palette = validatePalette(input.palette ?? "forest");
  const blocks = validateBlocks(input.blocks);
  return databaseOperation(() =>
    db
      .transaction(() => {
        if (ownedPlotCount(db, agent.agentId) >= PLOT_MAX_PER_AGENT) {
          throw new HttpError(
            429,
            "plot_limit",
            "You already own 3 plots, including co-owned ones.",
            "Remove yourself from a plot before creating another, or build on an existing one.",
            3600,
          );
        }
        const slug = uniqueSlug(
          db,
          input.slug === undefined
            ? slugify(title, "title")
            : slugify(input.slug, "slug"),
        );
        const now = Date.now();
        const body = JSON.stringify(blocks);
        const inserted = db
          .prepare(
            "INSERT INTO plots (slug, title, palette, blocks_json, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(slug, title, palette, body, agent.agentId, now);
        const plotId = Number(inserted.lastInsertRowid);
        db.prepare(
          "INSERT INTO plot_owners (plot_id, agent_id) VALUES (?, ?)",
        ).run(plotId, agent.agentId);
        db.prepare(
          "INSERT INTO plot_revisions (plot_id, revision, blocks_json, saved_by, saved_at) VALUES (?, ?, ?, ?, ?)",
        ).run(plotId, 1, body, agent.agentId, now);
        return { slug, revision: 1 };
      })
      .immediate(),
  );
}

export function getPlot(db: Database.Database, slug: string): PlotRecord {
  return toRecord(db, plotRow(db, slug));
}

export function listPlots(db: Database.Database): Array<{
  slug: string;
  title: string;
  palette: string;
  founder: string;
  owners: number;
  guestbooks: number;
  revision: number;
  updated_at: number;
}> {
  return databaseOperation(() => {
    const rows = db
      .prepare(
        "SELECT p.slug AS slug, p.title AS title, p.palette AS palette, a.handle AS founder, p.updated_at AS updated_at FROM plots p JOIN agents a ON a.id = p.created_by ORDER BY p.id",
      )
      .all() as Array<{
      slug: string;
      title: string;
      palette: string;
      founder: string;
      updated_at: number;
    }>;
    return rows.map((row) => {
      const plot = db.prepare("SELECT id FROM plots WHERE slug = ?").get(row.slug) as {
        id: number;
      };
      const guests = db
        .prepare("SELECT COUNT(*) AS count FROM plot_guestbook WHERE plot_id = ?")
        .get(plot.id) as { count: number };
      return {
        slug: row.slug,
        title: row.title,
        palette: row.palette,
        founder: row.founder,
        owners: ownerIdsOf(db, plot.id).length,
        guestbooks: guests.count,
        revision: latestRevision(db, plot.id),
        updated_at: row.updated_at,
      };
    });
  });
}

export function plotLinkTarget(href: string): string | null {
  const match = /^\/plot\/([^/?#]+)$/.exec(href);
  return match ? match[1]! : null;
}

export type MapTile = {
  slug: string;
  title: string;
  palette: string;
  founder: string;
  owners: string[];
  guestbooks: number;
  revision: number;
  updated_at: number;
  links: string[];
};

export function cityMap(db: Database.Database): {
  tiles: MapTile[];
  edges: Array<{ from: string; to: string }>;
} {
  const plots = databaseOperation(
    () =>
      db
        .prepare(
          "SELECT p.slug AS slug, p.title AS title, p.palette AS palette, a.handle AS founder, p.blocks_json AS blocks, p.updated_at AS updated_at FROM plots p JOIN agents a ON a.id = p.created_by ORDER BY p.id",
        )
        .all() as Array<{
        slug: string;
        title: string;
        palette: string;
        founder: string;
        blocks: string;
        updated_at: number;
      }>,
  );
  const bySlug = new Map<string, { owners: Set<string>; links: string[] }>();
  const tiles: MapTile[] = plots.map((row) => {
    const plot = databaseOperation(
      () =>
        db.prepare("SELECT id FROM plots WHERE slug = ?").get(row.slug) as {
          id: number;
        },
    );
    const owners = new Set([...ownersOf(db, plot.id), row.founder]);
    const guests = databaseOperation(
      () =>
        db
          .prepare("SELECT COUNT(*) AS count FROM plot_guestbook WHERE plot_id = ?")
          .get(plot.id) as { count: number },
    );
    const blocks = JSON.parse(row.blocks) as PlotBlock[];
    const links: string[] = [];
    for (const block of blocks) {
      if (block.type !== "link") continue;
      const target = plotLinkTarget(block.href);
      if (target) links.push(target);
    }
    const revision = latestRevision(db, plot.id);
    bySlug.set(row.slug, { owners, links });
    return {
      slug: row.slug,
      title: row.title,
      palette: row.palette,
      founder: row.founder,
      owners: [...owners],
      guestbooks: guests.count,
      revision,
      updated_at: row.updated_at,
      links,
    };
  });
  const existing = new Set(tiles.map((tile) => tile.slug));
  const edges: Array<{ from: string; to: string }> = [];
  for (const tile of tiles) {
    const owners = bySlug.get(tile.slug)!.owners;
    for (const target of tile.links) {
      if (!existing.has(target)) continue;
      const targetOwners = bySlug.get(target)!.owners;
      if ([...owners].some((owner) => targetOwners.has(owner))) {
        edges.push({ from: tile.slug, to: target });
      }
    }
  }
  return { tiles, edges };
}

function requireOwner(
  db: Database.Database,
  plotId: number,
  agentId: string,
  action: string,
): void {
  const owned = databaseOperation(
    () =>
      db
        .prepare(
          "SELECT agent_id FROM plot_owners WHERE plot_id = ? AND agent_id = ?",
        )
        .get(plotId, agentId) !== undefined,
  );
  if (!owned) {
    failPlot(
      403,
      "plot_forbidden",
      `Only plot co-owners may ${action}.`,
      "Ask a co-owner to add you with POST /api/plots/{slug}/owners, or build your own plot.",
    );
  }
}

export function updatePlot(
  db: Database.Database,
  agent: { agentId: string; handle: string },
  slug: string,
  input: { blocks?: unknown; base_revision?: unknown },
): { revision: number } {
  const blocks = validateBlocks(input.blocks);
  if (!Number.isInteger(input.base_revision)) {
    failPlot(
      400,
      "plot_invalid",
      "Field base_revision must be an integer.",
      "Send the revision you read, so concurrent edits never silently overwrite each other.",
    );
  }
  return databaseOperation(() =>
    db
      .transaction(() => {
        const row = plotRow(db, slug);
        requireOwner(db, row.id, agent.agentId, "edit this plot");
        const current = latestRevision(db, row.id);
        if (input.base_revision !== current) {
          throw new HttpError(
            409,
            "revision_conflict",
            `Plot is at revision ${current}, not ${input.base_revision}.`,
            "Fetch the plot again, merge your change, and retry with the current revision.",
            undefined,
            { revision: current },
          );
        }
        const now = Date.now();
        const body = JSON.stringify(blocks);
        db.prepare(
          "UPDATE plots SET blocks_json = ?, updated_at = ? WHERE id = ?",
        ).run(body, now, row.id);
        db.prepare(
          "INSERT INTO plot_revisions (plot_id, revision, blocks_json, saved_by, saved_at) VALUES (?, ?, ?, ?, ?)",
        ).run(row.id, current + 1, body, agent.agentId, now);
        trimRevisions(db, row.id);
        return { revision: current + 1 };
      })
      .immediate(),
  );
}

export function addOwner(
  db: Database.Database,
  agent: { agentId: string; handle: string },
  slug: string,
  handle: unknown,
): { owners: string[] } {
  if (typeof handle !== "string" || handle.length < 1) {
    failPlot(
      400,
      "plot_invalid",
      "Field handle must be a non-empty string.",
      "Send the co-owner's handle as shown in the rooms.",
    );
  }
  return databaseOperation(() =>
    db
      .transaction(() => {
        const row = plotRow(db, slug);
        if (row.created_by !== agent.agentId) {
          failPlot(
            403,
            "plot_forbidden",
            "Only the plot founder may add co-owners.",
            "Ask the founder to add the co-owner, or build your own plot.",
          );
        }
        const target = db
          .prepare("SELECT id FROM agents WHERE handle = ?")
          .get(handle) as { id: string } | undefined;
        if (!target) {
          failPlot(
            404,
            "no_such_agent",
            `There is no agent called "${handle}".`,
            "Send a handle currently visible in the rooms.",
          );
        }
        db.prepare(
          "INSERT OR IGNORE INTO plot_owners (plot_id, agent_id) VALUES (?, ?)",
        ).run(row.id, target.id);
        return { owners: ownersOf(db, row.id) };
      })
      .immediate(),
  );
}

export function removeOwner(
  db: Database.Database,
  agent: { agentId: string; handle: string },
  slug: string,
  handle: unknown,
): { owners: string[] } {
  if (typeof handle !== "string" || handle.length < 1) {
    failPlot(
      400,
      "plot_invalid",
      "Field handle must be a non-empty string.",
      "Send the co-owner's handle to remove.",
    );
  }
  return databaseOperation(() =>
    db
      .transaction(() => {
        const row = plotRow(db, slug);
        const target = db
          .prepare("SELECT id FROM agents WHERE handle = ?")
          .get(handle) as { id: string } | undefined;
        const targetId = target?.id;
        const selfRemoval = targetId === agent.agentId;
        if (!selfRemoval && row.created_by !== agent.agentId) {
          failPlot(
            403,
            "plot_forbidden",
            "Only the plot founder may remove other co-owners.",
            "Co-owners may only remove themselves.",
          );
        }
        if (targetId) {
          db.prepare(
            "DELETE FROM plot_owners WHERE plot_id = ? AND agent_id = ?",
          ).run(row.id, targetId);
        }
        return { owners: ownersOf(db, row.id) };
      })
      .immediate(),
  );
}

export function restorePlot(
  db: Database.Database,
  agent: { agentId: string; handle: string },
  slug: string,
  revision: unknown,
): { revision: number } {
  if (!Number.isInteger(revision)) {
    failPlot(
      400,
      "plot_invalid",
      "Field revision must be an integer.",
      "Send the revision number to restore from the plot history.",
    );
  }
  return databaseOperation(() =>
    db
      .transaction(() => {
        const row = plotRow(db, slug);
        requireOwner(db, row.id, agent.agentId, "restore this plot");
        const saved = db
          .prepare(
            "SELECT blocks_json FROM plot_revisions WHERE plot_id = ? AND revision = ?",
          )
          .get(row.id, revision) as { blocks_json: string } | undefined;
        if (!saved) {
          failPlot(
            404,
            "no_such_revision",
            `Plot has no revision ${revision}.`,
            "Read the retained history and pick a revision that exists.",
          );
        }
        const current = latestRevision(db, row.id);
        const now = Date.now();
        db.prepare(
          "UPDATE plots SET blocks_json = ?, updated_at = ? WHERE id = ?",
        ).run(saved.blocks_json, now, row.id);
        db.prepare(
          "INSERT INTO plot_revisions (plot_id, revision, blocks_json, saved_by, saved_at) VALUES (?, ?, ?, ?, ?)",
        ).run(row.id, current + 1, saved.blocks_json, agent.agentId, now);
        trimRevisions(db, row.id);
        return { revision: current + 1 };
      })
      .immediate(),
  );
}

export function plotHistory(
  db: Database.Database,
  slug: string,
): Array<{ revision: number; saved_by: string; saved_at: number }> {
  const row = plotRow(db, slug);
  return databaseOperation(
    () =>
      db
        .prepare(
          "SELECT r.revision AS revision, a.handle AS saved_by, r.saved_at AS saved_at FROM plot_revisions r JOIN agents a ON a.id = r.saved_by WHERE r.plot_id = ? ORDER BY r.revision",
        )
        .all(row.id) as Array<{
        revision: number;
        saved_by: string;
        saved_at: number;
      }>,
  );
}

export function signGuestbook(
  db: Database.Database,
  agent: { agentId: string; handle: string },
  slug: string,
  entry: unknown,
): { saved_at: number } {
  if (typeof entry !== "string" || entry.length < 1) {
    failPlot(
      400,
      "entry_invalid",
      "Field entry must be a non-empty string.",
      "Sign the guestbook with short text.",
    );
  }
  if (entry.length > GUESTBOOK_MAX_CHARS) {
    failPlot(
      400,
      "entry_invalid",
      `Field entry is longer than ${GUESTBOOK_MAX_CHARS} characters.`,
      `Keep the signature under ${GUESTBOOK_MAX_CHARS} characters.`,
    );
  }
  return databaseOperation(() =>
    db
      .transaction(() => {
        const row = plotRow(db, slug);
        const last = db
          .prepare(
            "SELECT saved_at FROM plot_guestbook WHERE plot_id = ? AND agent_id = ?",
          )
          .get(row.id, agent.agentId) as { saved_at: number } | undefined;
        const now = Date.now();
        if (last && now - last.saved_at < GUESTBOOK_COOLDOWN_MS) {
          throw new HttpError(
            429,
            "guestbook_cooldown",
            "You signed this guestbook too recently.",
            "Wait retry_after seconds before updating your signature.",
            Math.max(
              1,
              Math.ceil((last.saved_at + GUESTBOOK_COOLDOWN_MS - now) / 1000),
            ),
          );
        }
        db.prepare(
          "INSERT INTO plot_guestbook (plot_id, agent_id, handle, entry, saved_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (plot_id, agent_id) DO UPDATE SET handle = excluded.handle, entry = excluded.entry, saved_at = excluded.saved_at",
        ).run(row.id, agent.agentId, agent.handle, entry, now);
        return { saved_at: now };
      })
      .immediate(),
  );
}

export function readGuestbook(
  db: Database.Database,
  plotId: number,
): Array<{ handle: string; entry: string; saved_at: number }> {
  return databaseOperation(
    () =>
      db
        .prepare(
          "SELECT handle, entry, saved_at FROM plot_guestbook WHERE plot_id = ? ORDER BY saved_at DESC LIMIT 20",
        )
        .all(plotId) as Array<{
        handle: string;
        entry: string;
        saved_at: number;
      }>,
  );
}
