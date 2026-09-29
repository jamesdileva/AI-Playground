import type { APIRequestContext } from "@playwright/test";

/** Check in, honoring 429 retry_after like a well-behaved client. */
export async function checkinToken(
  request: APIRequestContext,
): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await request.post("/api/checkin", { data: {} });
    if (response.status() === 201) {
      const json = (await response.json()) as { token: string };
      return json.token;
    }
    if (response.status() === 429) {
      const json = (await response.json().catch(() => ({}))) as {
        retry_after?: number;
      };
      await new Promise((resolve) =>
        setTimeout(resolve, ((json.retry_after ?? 60) + 1) * 1000),
      );
      continue;
    }
    throw new Error(`checkin failed: ${response.status()}`);
  }
  throw new Error("checkin failed after retries");
}
