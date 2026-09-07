import { NextRequest, NextResponse } from "next/server";

function getAllowlist(): string[] {
  const configured = (process.env.PLAYGROUND_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const origins = new Set<string>();
  for (const entry of [process.env.DEMO_SERVER_URL || "http://localhost:3003", ...configured]) {
    try {
      origins.add(new URL(entry).origin);
    } catch {
      // ignore malformed
    }
  }
  return [...origins];
}

function transportTarget(target: URL): URL {
  const mappings = [
    [process.env.DEMO_SERVER_URL, process.env.DEMO_SERVER_INTERNAL_URL],
    [process.env.GATEWAY_URL, process.env.GATEWAY_INTERNAL_URL],
  ] as const;
  for (const [publicUrl, internalUrl] of mappings) {
    if (!publicUrl || !internalUrl) continue;
    const publicOrigin = new URL(publicUrl).origin;
    if (target.origin !== publicOrigin) continue;
    const transport = new URL(internalUrl);
    transport.pathname = target.pathname;
    transport.search = target.search;
    return transport;
  }
  return target;
}

export async function POST(req: NextRequest) {
  let body: { url?: unknown; method?: unknown; headers?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body", message: "Expected a JSON object." }, { status: 400 });
  }

  if (typeof body.url !== "string") {
    return NextResponse.json({ error: "invalid_url", message: "'url' must be a string." }, { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(body.url);
  } catch {
    return NextResponse.json({ error: "invalid_url", message: "Target URL could not be parsed." }, { status: 400 });
  }

  const allowlist = getAllowlist();
  if (!allowlist.includes(target.origin)) {
    return NextResponse.json(
      {
        error: "target_forbidden",
        message: `Target origin '${target.origin}' is not on the allowlist.`,
        allowlist,
      },
      { status: 403 }
    );
  }

  const method = typeof body.method === "string" ? body.method.toUpperCase() : "GET";
  if (!["GET", "POST"].includes(method)) {
    return NextResponse.json({ error: "method_not_allowed", message: "Only GET and POST are permitted." }, { status: 405 });
  }

  const headers: Record<string, string> = {};
  if (body.headers && typeof body.headers === "object") {
    for (const [k, v] of Object.entries(body.headers)) {
      if (typeof v === "string") headers[k] = v;
    }
  }

  try {
    const response = await fetch(transportTarget(target).toString(), {
      method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(85_000),
    });

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });

    const rawText = await response.text();
    let parsedBody: unknown = rawText;
    try {
      parsedBody = JSON.parse(rawText);
    } catch {
      // raw text
    }

    return NextResponse.json({
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: parsedBody,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "fetch_failed",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 502 }
    );
  }
}
