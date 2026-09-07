import { readFile } from "node:fs/promises";
import { config as loadDotenv } from "dotenv";
import { serve } from "@hono/node-server";
import { createGatewayApp } from "./app.js";
import type { GatewayConfig } from "./types.js";

loadDotenv({ path: [".env", "../.env"], quiet: true });

const configPath = process.env.GATEWAY_CONFIG ?? "gateway.config.json";
const config = JSON.parse(await readFile(configPath, "utf8")) as GatewayConfig;
const port = Number(process.env.GATEWAY_PORT ?? 3005);
const host = process.env.GATEWAY_HOST ?? "0.0.0.0";
const app = createGatewayApp(config);

serve({ fetch: app.fetch, port, hostname: host });
process.stdout.write(`Veridex gateway '${config.id}' listening on http://${host}:${port}\n`);

export { createGatewayApp } from "./app.js";
export { validateGatewayConfig } from "./config.js";
export { InMemoryGatewayEventStore } from "./store.js";
export type * from "./types.js";