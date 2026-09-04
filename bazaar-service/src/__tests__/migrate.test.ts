import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations, type MigrationClient } from "../db/migrate.js";

class FakeMigrationClient implements MigrationClient {
  queries: { text: string; params?: unknown[] }[] = [];
  applied = new Set<string>();
  failOn?: string;

  async query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }> {
    this.queries.push({ text, params });
    if (text.includes("SELECT filename")) return { rows: [...this.applied].map((filename) => ({ filename }) as T) };
    if (text.startsWith("INSERT INTO schema_migrations") && params?.[0]) this.applied.add(String(params[0]));
    if (this.failOn && text.includes(this.failOn)) throw new Error("migration failed");
    return { rows: [] };
  }

  release(): void {}
}

describe("Bazaar migrations", () => {
  it("applies SQL files in order and skips them on the next run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "veridex-migrations-"));
    try {
      await writeFile(join(directory, "002-second.sql"), "SELECT 2");
      await writeFile(join(directory, "001-first.sql"), "SELECT 1");
      const client = new FakeMigrationClient();

      expect(await runMigrations(client, directory)).toEqual(["001-first.sql", "002-second.sql"]);
      expect(await runMigrations(client, directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rolls back and reports the failed filename", async () => {
    const directory = await mkdtemp(join(tmpdir(), "veridex-migrations-"));
    try {
      await writeFile(join(directory, "001-fail.sql"), "SELECT fail_marker");
      const client = new FakeMigrationClient();
      client.failOn = "fail_marker";
      await expect(runMigrations(client, directory)).rejects.toThrow("001-fail.sql");
      expect(client.queries.some(({ text }) => text === "ROLLBACK")).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
