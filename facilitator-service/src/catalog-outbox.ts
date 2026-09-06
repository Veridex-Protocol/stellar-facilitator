/**
 * Durable local outbox for post-settlement Bazaar catalog work.
 * License: Apache-2.0
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CatalogOutboxEvent {
  version: 1;
  id: string;
  createdAt: string;
  attempts: number;
  payload: Record<string, unknown>;
}

export interface CatalogOutboxStats {
  pending: number;
  oldestAgeSeconds: number;
}

export class CatalogOutbox {
  constructor(private readonly directory: string) {}

  async enqueue(id: string, payload: Record<string, unknown>): Promise<CatalogOutboxEvent> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const existing = await this.read(id).catch(() => undefined);
    if (existing) return existing;
    const event: CatalogOutboxEvent = {
      version: 1,
      id,
      createdAt: new Date().toISOString(),
      attempts: 0,
      payload,
    };
    const target = this.pathFor(id);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, target);
    return event;
  }

  async acknowledge(id: string): Promise<void> {
    await rm(this.pathFor(id), { force: true });
  }

  async markAttempt(event: CatalogOutboxEvent): Promise<CatalogOutboxEvent> {
    const updated = { ...event, attempts: event.attempts + 1 };
    const target = this.pathFor(event.id);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(updated)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
    return updated;
  }

  async list(limit = 20): Promise<CatalogOutboxEvent[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const names = (await readdir(this.directory))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .slice(0, Math.max(1, Math.min(100, limit)));
    const events: CatalogOutboxEvent[] = [];
    for (const name of names) {
      try {
        const parsed = JSON.parse(await readFile(join(this.directory, name), "utf8")) as CatalogOutboxEvent;
        if (parsed.version === 1 && parsed.id && parsed.payload) events.push(parsed);
      } catch {
        // A corrupt event is retained for operator inspection rather than deleted.
      }
    }
    return events;
  }

  async stats(): Promise<CatalogOutboxStats> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json"));
    let oldest = Date.now();
    for (const name of names) {
      const details = await stat(join(this.directory, name));
      oldest = Math.min(oldest, details.mtimeMs);
    }
    return {
      pending: names.length,
      oldestAgeSeconds: names.length === 0 ? 0 : Math.max(0, (Date.now() - oldest) / 1000),
    };
  }

  private async read(id: string): Promise<CatalogOutboxEvent> {
    return JSON.parse(await readFile(this.pathFor(id), "utf8")) as CatalogOutboxEvent;
  }

  private pathFor(id: string): string {
    if (!/^[0-9a-f]{64}$/i.test(id)) throw new Error("catalog outbox id must be a transaction hash");
    return join(this.directory, `${id.toLowerCase()}.json`);
  }
}