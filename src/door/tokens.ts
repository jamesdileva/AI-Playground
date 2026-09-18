import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

const TOKEN_PREFIX = "hng_";

export function mintToken(): { token: string; tokenHash: string } {
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokenHashMatches(
  tokenHash: string,
  candidate: string,
): boolean {
  if (
    typeof tokenHash !== "string" ||
    !/^[a-f0-9]{64}$/i.test(tokenHash) ||
    typeof candidate !== "string"
  ) {
    return false;
  }
  const expected = Buffer.from(tokenHash, "hex");
  const actual = Buffer.from(hashToken(candidate), "hex");
  return (
    expected.length === actual.length && timingSafeEqual(expected, actual)
  );
}
