import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogOutbox } from "../catalog-outbox.js";

describe("durable catalog outbox", () => {
  it("persists one idempotent event per settlement until acknowledged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "veridex-outbox-"));
    try {
      const outbox = new CatalogOutbox(directory);
      const id = "a".repeat(64);
      const first = await outbox.enqueue(id, { resourceUrl: "https://seller.example/a" });
      const duplicate = await outbox.enqueue(id, { resourceUrl: "https://forged.example/b" });

      expect(duplicate.payload).toEqual(first.payload);
      expect(await outbox.stats()).toMatchObject({ pending: 1 });
      expect(await outbox.list()).toEqual([first]);

      const attempted = await outbox.markAttempt(first);
      expect(attempted.attempts).toBe(1);
      expect((await outbox.list())[0].attempts).toBe(1);

      await outbox.acknowledge(id);
      expect(await outbox.stats()).toEqual({ pending: 0, oldestAgeSeconds: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a non-transaction id before writing a file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "veridex-outbox-"));
    try {
      const outbox = new CatalogOutbox(directory);
      await expect(outbox.enqueue("../escape", {})).rejects.toThrow(/transaction hash/);
      expect(await outbox.stats()).toEqual({ pending: 0, oldestAgeSeconds: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});