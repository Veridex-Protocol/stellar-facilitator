import { describe, expect, it } from "vitest";
import { postCatalogIngest } from "../server.js";

describe("post-settlement catalog handoff", () => {
  it("abandons an unavailable indexer at the configured deadline", async () => {
    const startedAt = Date.now();
    await expect(postCatalogIngest(
      new URL("https://bazaar.example/catalog/ingest"),
      { method: "POST", body: "{}" },
      20,
      ((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })) as typeof fetch,
    )).rejects.toMatchObject({ name: "TimeoutError" });

    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it("returns the catalog response when it completes inside the deadline", async () => {
    const response = await postCatalogIngest(
      new URL("https://bazaar.example/catalog/ingest"),
      { method: "POST", body: "{}" },
      100,
      (async () => new Response("accepted", { status: 202 })) as typeof fetch,
    );

    expect(response.status).toBe(202);
  });
});