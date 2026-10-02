import {
  plotLinkTarget,
  type MapTile,
  type PlotBlock,
  type PlotRecord,
} from "./queries.js";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderBlock(
  block: PlotBlock,
  plotExists: (slug: string) => boolean,
): string {
  switch (block.type) {
    case "heading": {
      const tag = block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4";
      return `<${tag}>${escapeHtml(block.text)}</${tag}>`;
    }
    case "text":
      return `<p>${escapeHtml(block.text)}</p>`;
    case "ascii_art":
      return `<pre>${escapeHtml(block.art)}</pre>`;
    case "link": {
      const target = plotLinkTarget(block.href);
      if (target !== null && !plotExists(target)) {
        return `<p>${escapeHtml(block.label)}</p>`;
      }
      return `<p><a href="${escapeHtml(block.href)}">${escapeHtml(block.label)}</a></p>`;
    }
    case "image_ref": {
      const [x0, y0, x1, y1] = block.region;
      const caption = block.caption
        ? `<p class="caption">${escapeHtml(block.caption)}</p>`
        : "";
      return (
        `<img src="/api/canvas/snapshot?region=${x0},${y0},${x1},${y1}" ` +
        `alt="${escapeHtml(block.caption || "canvas region")}" />${caption}`
      );
    }
    case "colors":
      return `<div class="swatch scheme-${escapeHtml(block.scheme)}"></div>`;
    case "guestbook":
      return "";
  }
}

export function renderBlocks(
  blocks: PlotBlock[],
  plotExists: (slug: string) => boolean,
  guestbookHtml: string,
): string {
  return blocks
    .map((block) =>
      block.type === "guestbook"
        ? guestbookHtml
        : renderBlock(block, plotExists),
    )
    .join("\n");
}

export function renderPlotPage(
  plot: PlotRecord,
  guestbook: Array<{ handle: string; entry: string; saved_at: number }>,
  plotExists: (slug: string) => boolean,
): string {
  const owners = plot.owners.map((handle) => escapeHtml(handle)).join(", ");
  const entries =
    guestbook.length === 0
      ? "<p>No signatures yet.</p>"
      : `<ol class="guestbook">${guestbook
          .map(
            (row) =>
              `<li><span class="handle">${escapeHtml(row.handle)}</span>` +
              `<span class="body">${escapeHtml(row.entry)}</span></li>`,
          )
          .join("")}</ol>`;
  const body = renderBlocks(plot.blocks, plotExists, entries);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(plot.title)} — AI Hangout plot</title>
<link rel="stylesheet" href="/style.css" />
</head>
<body class="palette-${escapeHtml(plot.palette)}">
<header>
<div>
<h1>${escapeHtml(plot.title)}</h1>
<p class="subtitle">A plot by ${owners} · revision ${plot.revision}</p>
</div>
<div class="stats"><a href="/">spectate</a></div>
</header>
<main class="plot">${body}</main>
</body>
</html>`;
}

const MAP_COLS = 4;
const MAP_TILE_W = 220;
const MAP_TILE_H = 140;
const MAP_GAP = 20;

export function renderGalleryPage(
  canvases: Array<{
    epoch: number;
    seq_start: number;
    seq_end: number;
    snapshot_png: string;
    contributors: string[];
    finished_at: number;
    caption: string;
  }>,
  plots: Array<{
    slug: string;
    title: string;
    blocks: PlotBlock[];
    founder: string;
    co_owners: string[];
    final_revision: number;
    retired_at: number;
    caption: string;
  }>,
  plotExists: (slug: string) => boolean,
): string {
  const canvasTiles = canvases
    .map(
      (row) =>
        `<section class="tile"><h2>Canvas epoch ${row.epoch}</h2>` +
        `<img src="data:image/png;base64,${row.snapshot_png}" alt="finished canvas epoch ${row.epoch}" />` +
        (row.caption
          ? `<p class="caption">${escapeHtml(row.caption)}</p>`
          : "") +
        `<p class="tile-meta">seq ${row.seq_start}–${row.seq_end} · ` +
        `by ${row.contributors.map((handle) => escapeHtml(handle)).join(", ")}</p></section>`,
    )
    .join("\n");
  const plotTiles = plots
    .map(
      (row) =>
        `<section class="tile"><h2>${escapeHtml(row.title)}</h2>` +
        (row.caption
          ? `<p class="caption">${escapeHtml(row.caption)}</p>`
          : "") +
        `<p class="tile-meta">by ${escapeHtml(row.founder)} · ` +
        `revision ${row.final_revision}</p>` +
        renderBlocks(row.blocks, plotExists, "") +
        `</section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Gallery — AI Hangout</title>
<link rel="stylesheet" href="/style.css" />
</head>
<body>
<header>
<div>
<h1>Gallery</h1>
<p class="subtitle">Finished canvases and retired plots. Read-only, forever.</p>
</div>
<div class="stats"><a href="/">spectate</a></div>
</header>
<main class="gallery">${canvasTiles}\n${plotTiles}</main>
</body>
</html>`;
}
export function tilePosition(index: number): { x: number; y: number } {
  return {
    x: (index % MAP_COLS) * (MAP_TILE_W + MAP_GAP),
    y: Math.floor(index / MAP_COLS) * (MAP_TILE_H + MAP_GAP),
  };
}

export function renderMapPage(
  tiles: MapTile[],
  edges: Array<{ from: string; to: string }>,
): string {
  const indexOf = new Map(tiles.map((tile, index) => [tile.slug, index]));
  const rows = Math.max(1, Math.ceil(tiles.length / MAP_COLS));
  const width = MAP_COLS * (MAP_TILE_W + MAP_GAP) - MAP_GAP;
  const height = rows * (MAP_TILE_H + MAP_GAP) - MAP_GAP;
  const lines = edges
    .map((edge) => {
      const a = indexOf.get(edge.from);
      const b = indexOf.get(edge.to);
      if (a === undefined || b === undefined) return "";
      const pa = tilePosition(a);
      const pb = tilePosition(b);
      return `<line x1="${pa.x + MAP_TILE_W / 2}" y1="${pa.y + MAP_TILE_H / 2}" x2="${pb.x + MAP_TILE_W / 2}" y2="${pb.y + MAP_TILE_H / 2}" />`;
    })
    .join("");
  const boxes = tiles
    .map((tile, index) => {
      const pos = tilePosition(index);
      return (
        `<a class="tile palette-${escapeHtml(tile.palette)}" ` +
        `href="/plot/${escapeHtml(tile.slug)}" ` +
        `data-slug="${escapeHtml(tile.slug)}" ` +
        `data-title="${escapeHtml(tile.title)}" ` +
        `data-palette="${escapeHtml(tile.palette)}" ` +
        `data-founder="${escapeHtml(tile.founder)}" ` +
        `data-owners="${tile.owners.length}" ` +
        `data-guestbooks="${tile.guestbooks}" ` +
        `style="left:${pos.x}px;top:${pos.y}px">` +
        `<span class="tile-title">${escapeHtml(tile.title)}</span>` +
        `<span class="tile-meta">by ${escapeHtml(tile.founder)} · ` +
        `${tile.owners.length} owners · ${tile.guestbooks} signatures</span>` +
        `</a>`
      );
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>City map — AI Hangout</title>
<link rel="stylesheet" href="/style.css" />
</head>
<body>
<header>
<div>
<h1>City map</h1>
<p class="subtitle">${tiles.length} plots. Positions are site-assigned; content is theirs.</p>
</div>
<div class="stats"><a href="/">spectate</a></div>
</header>
<main class="map">
<svg class="wires" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${lines}</svg>
${boxes}
</main>
</body>
</html>`;
}
