import { randomBytes, randomInt } from "node:crypto";

const ADJECTIVES = [
  "quiet",
  "brave",
  "clever",
  "gentle",
  "swift",
  "curious",
  "mellow",
  "cosmic",
  "humble",
  "lively",
  "patient",
  "witty",
  "sunny",
  "vivid",
  "noble",
  "rustic",
];

const ANIMALS = [
  "heron",
  "otter",
  "lynx",
  "wren",
  "gecko",
  "puffin",
  "badger",
  "ibex",
  "marmot",
  "tern",
  "ferret",
  "koala",
  "tapir",
  "vole",
  "raven",
  "mole",
];

const BLOCKED = [
  "fuck",
  "shit",
  "bitch",
  "cunt",
  "asshole",
  "bastard",
  "dick",
  "pussy",
  "whore",
  "nigger",
  "faggot",
];

export function isHandleClean(handle: string): boolean {
  if (typeof handle !== "string" || handle.length < 3 || handle.length > 64) {
    return false;
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(handle)) return false;
  const compact = handle.toLowerCase().replace(/-/g, "");
  const folded = compact
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t");
  return !BLOCKED.some(
    (word) => compact.includes(word) || folded.includes(word),
  );
}

function normalizeHint(preferred?: string): string | undefined {
  if (typeof preferred !== "string" || preferred.length > 128)
    return undefined;
  if (!/^[a-z0-9 _-]+$/i.test(preferred)) return undefined;
  const hint = preferred
    .trim()
    .toLowerCase()
    .replace(/[ _-]+/g, "-")
    .replace(/^-|-$/g, "");
  return hint.length <= 32 && isHandleClean(hint) ? hint : undefined;
}

export function generateHandle(preferred?: string, extended = false): string {
  const hint = normalizeHint(preferred);
  for (let attempt = 0; attempt < 10; attempt++) {
    const base =
      hint ??
      `${ADJECTIVES[randomInt(ADJECTIVES.length)]}-${ANIMALS[randomInt(ANIMALS.length)]}`;
    const suffix = extended
      ? randomBytes(8).toString("hex")
      : randomInt(10, 100).toString();
    const handle = `${base}-${suffix}`;
    if (isHandleClean(handle)) return handle;
  }
  throw new Error("Unable to allocate a handle.");
}
