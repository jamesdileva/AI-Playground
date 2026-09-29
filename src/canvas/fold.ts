import {
  createCanvas,
  type Canvas,
  type SKRSContext2D,
} from "@napi-rs/canvas";
import { CANVAS_SIZE, type CanvasOp } from "./queries.js";

export const SNAPSHOT_BACKGROUND = "#222233";
export const SNAPSHOT_MIME = "image/png";
export const CANVAS_MODE = "free-draw";

export type FoldCanvas = Canvas;
type Ctx = SKRSContext2D;

export function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function floodFill(
  ctx: Ctx,
  seedX: number,
  seedY: number,
  fill: [number, number, number],
): void {
  const seed = ctx.getImageData(seedX, seedY, 1, 1).data;
  if (
    seed[0] === fill[0] &&
    seed[1] === fill[1] &&
    seed[2] === fill[2] &&
    seed[3] === 255
  ) {
    return;
  }
  const image = ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  const data = image.data;
  const at = (x: number, y: number): number => (y * CANVAS_SIZE + x) * 4;
  const start = at(seedX, seedY);
  const target: [number, number, number, number] = [
    data[start]!,
    data[start + 1]!,
    data[start + 2]!,
    data[start + 3]!,
  ];
  const stack: Array<[number, number]> = [[seedX, seedY]];
  const seen = new Uint8Array(CANVAS_SIZE * CANVAS_SIZE);
  seen[seedY * CANVAS_SIZE + seedX] = 1;
  while (stack.length > 0) {
    const [x, y] = stack.pop()!;
    const i = at(x, y);
    if (
      data[i] !== target[0] ||
      data[i + 1] !== target[1] ||
      data[i + 2] !== target[2] ||
      data[i + 3] !== target[3]
    ) {
      continue;
    }
    data[i] = fill[0];
    data[i + 1] = fill[1];
    data[i + 2] = fill[2];
    data[i + 3] = 255;
    if (x > 0 && !seen[y * CANVAS_SIZE + x - 1]) {
      seen[y * CANVAS_SIZE + x - 1] = 1;
      stack.push([x - 1, y]);
    }
    if (x < CANVAS_SIZE - 1 && !seen[y * CANVAS_SIZE + x + 1]) {
      seen[y * CANVAS_SIZE + x + 1] = 1;
      stack.push([x + 1, y]);
    }
    if (y > 0 && !seen[(y - 1) * CANVAS_SIZE + x]) {
      seen[(y - 1) * CANVAS_SIZE + x] = 1;
      stack.push([x, y - 1]);
    }
    if (y < CANVAS_SIZE - 1 && !seen[(y + 1) * CANVAS_SIZE + x]) {
      seen[(y + 1) * CANVAS_SIZE + x] = 1;
      stack.push([x, y + 1]);
    }
  }
  ctx.putImageData(image, 0, 0);
}

export function applyOp(ctx: Ctx, op: CanvasOp): void {
  switch (op.op) {
    case "stroke": {
      ctx.strokeStyle = op.color;
      ctx.lineWidth = op.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      const [first, ...rest] = op.pts;
      ctx.moveTo(first![0] + 0.5, first![1] + 0.5);
      for (const [x, y] of rest) ctx.lineTo(x + 0.5, y + 0.5);
      ctx.stroke();
      return;
    }
    case "rect": {
      if (op.fill) {
        ctx.fillStyle = op.color;
        ctx.fillRect(op.x, op.y, op.w, op.h);
      } else {
        ctx.strokeStyle = op.color;
        ctx.lineWidth = 2;
        ctx.strokeRect(op.x, op.y, op.w, op.h);
      }
      return;
    }
    case "fill": {
      floodFill(ctx, op.x, op.y, hexToRgb(op.color));
      return;
    }
    case "text": {
      ctx.fillStyle = op.color;
      ctx.font = `${op.size}px sans-serif`;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(op.text, op.x, op.y);
      return;
    }
  }
}

export function foldOps(ops: CanvasOp[]): Buffer {
  const canvas = foldToCanvas(ops);
  drawWatermark(canvas, ops.length);
  return canvas.toBuffer("image/png");
}

export function createBlankCanvas(): FoldCanvas {
  const canvas = createCanvas(CANVAS_SIZE, CANVAS_SIZE);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = SNAPSHOT_BACKGROUND;
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  return canvas;
}

export function createCanvasRegion(w: number, h: number): FoldCanvas {
  return createCanvas(w, h);
}

export function renderOps(canvas: FoldCanvas, ops: CanvasOp[]): void {
  const ctx = canvas.getContext("2d");
  for (const op of ops) applyOp(ctx, op);
}

export function foldToCanvas(ops: CanvasOp[]): FoldCanvas {
  const canvas = createBlankCanvas();
  renderOps(canvas, ops);
  return canvas;
}

export function drawWatermark(canvas: FoldCanvas, opCount: number): void {
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#9a9ab0";
  ctx.font = "10px sans-serif";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(`${CANVAS_MODE} · ${opCount} ops`, 10, CANVAS_SIZE - 10);
}

/** Pixels a flood fill from (seedX, seedY) would repaint. Read-only.
 * Repainting the seed's own color is a no-op and costs nothing. */
export function countFillArea(
  canvas: FoldCanvas,
  seedX: number,
  seedY: number,
  fill: [number, number, number],
): number {
  const ctx = canvas.getContext("2d");
  const seed = ctx.getImageData(seedX, seedY, 1, 1).data;
  if (
    seed[0] === fill[0] &&
    seed[1] === fill[1] &&
    seed[2] === fill[2] &&
    seed[3] === 255
  ) {
    return 0;
  }
  const image = ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  const data = image.data;
  const at = (x: number, y: number): number => (y * CANVAS_SIZE + x) * 4;
  let count = 0;
  const seen = new Uint8Array(CANVAS_SIZE * CANVAS_SIZE);
  const stack: Array<[number, number]> = [[seedX, seedY]];
  seen[seedY * CANVAS_SIZE + seedX] = 1;
  while (stack.length > 0) {
    const [x, y] = stack.pop()!;
    const i = at(x, y);
    if (
      data[i] !== seed[0] ||
      data[i + 1] !== seed[1] ||
      data[i + 2] !== seed[2] ||
      data[i + 3] !== seed[3]
    ) {
      continue;
    }
    count++;
    if (x > 0 && !seen[y * CANVAS_SIZE + x - 1]) {
      seen[y * CANVAS_SIZE + x - 1] = 1;
      stack.push([x - 1, y]);
    }
    if (x < CANVAS_SIZE - 1 && !seen[y * CANVAS_SIZE + x + 1]) {
      seen[y * CANVAS_SIZE + x + 1] = 1;
      stack.push([x + 1, y]);
    }
    if (y > 0 && !seen[(y - 1) * CANVAS_SIZE + x]) {
      seen[(y - 1) * CANVAS_SIZE + x] = 1;
      stack.push([x, y - 1]);
    }
    if (y < CANVAS_SIZE - 1 && !seen[(y + 1) * CANVAS_SIZE + x]) {
      seen[(y + 1) * CANVAS_SIZE + x] = 1;
      stack.push([x, y + 1]);
    }
  }
  return count;
}
