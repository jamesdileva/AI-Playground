import type { PlotBlock, PlotRecord } from "./queries.js";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderBlock(block: PlotBlock): string {
  switch (block.type) {
    case "heading": {
      const tag = block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4";
      return `<${tag}>${escapeHtml(block.text)}</${tag}>`;
    }
    case "text":
      return `<p>${escapeHtml(block.text)}</p>`;
    case "ascii_art":
      return `<pre>${escapeHtml(block.art)}</pre>`;
    case "link":
      return `<p><a href="${escapeHtml(block.href)}">${escapeHtml(block.label)}</a></p>`;
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

export function renderPlotPage(
  plot: PlotRecord,
  guestbook: Array<{ handle: string; entry: string; saved_at: number }>,
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
  const body = plot.blocks
    .map((block) =>
      block.type === "guestbook" ? entries : renderBlock(block),
    )
    .join("\n");
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
