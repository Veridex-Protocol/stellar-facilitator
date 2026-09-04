/**
 * Idempotent PostgreSQL migration runner for the Bazaar service.
 * License: Apache-2.0
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase, getDefaultConfig } from "./config.js";

export interface MigrationClient {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  release(): void;
}

export async function runMigrations(
  client: MigrationClient,
  migrationDirectory: string,
): Promise<string[]> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const appliedResult = await client.query<{ filename: string }>("SELECT filename FROM schema_migrations");
  const applied = new Set(appliedResult.rows.map((row) => row.filename));
  const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  const executed: string[] = [];

  for (const filename of files) {
    if (applied.has(filename)) continue;
    const sql = await readFile(join(migrationDirectory, filename), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
      await client.query("COMMIT");
      executed.push(filename);
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${filename} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return executed;
}

export async function main(): Promise<void> {
  const database = createDatabase(getDefaultConfig());
  const client = await database.getPool().connect();
  try {
    const directory = join(dirname(fileURLToPath(import.meta.url)), "migrations");
    const executed = await runMigrations(client, directory);
    console.log(executed.length > 0 ? `Applied migrations: ${executed.join(", ")}` : "No pending migrations");
  } finally {
    client.release();
    await database.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
