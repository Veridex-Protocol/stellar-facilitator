const DEFAULT_TIMEOUT_MS = 15_000;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  label = "Request"
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`${label} timed out after ${Math.ceil(timeoutMs / 1000)}s (${url}).`);
    }

    throw new Error(`${label} could not reach ${url}.`);
  }
}
