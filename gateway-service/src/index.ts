import { readFile } from "node:fs/promises";
import { config as loadDotenv } from "dotenv";
import { serve } from "@hono/node-server";
import { createGatewayApp } from "./app.js";
import { JsonlGatewayEventStore } from "./store.js";
import type { GatewayConfig } from "./types.js";

loadDotenv({ path: [".env", "../.env"], quiet: true });

const configPath = process.env.GATEWAY_CONFIG ?? "gateway.config.json";
const fileConfig = JSON.parse(await readFile(configPath, "utf8")) as GatewayConfig;
const config: GatewayConfig = {
	...fileConfig,
	upstream: process.env.GATEWAY_UPSTREAM ?? fileConfig.upstream,
	publicBaseUrl: process.env.GATEWAY_PUBLIC_BASE_URL ?? fileConfig.publicBaseUrl,
	facilitatorUrl: process.env.FACILITATOR_URL ?? fileConfig.facilitatorUrl,
	payTo: process.env.GATEWAY_PAY_TO ?? fileConfig.payTo,
	asset: process.env.PAYMENT_ASSET ?? fileConfig.asset,
	price: process.env.PAYMENT_AMOUNT ?? fileConfig.price,
	bazaarUrl: process.env.BAZAAR_URL ?? fileConfig.bazaarUrl,
};
const port = Number(process.env.GATEWAY_PORT ?? 3005);
const host = process.env.GATEWAY_HOST ?? "0.0.0.0";
const app = await createGatewayApp(config, {
	eventStore: new JsonlGatewayEventStore(process.env.GATEWAY_DATA_DIRECTORY),
	providerOutcomeSecretKey: process.env.PROVIDER_OUTCOME_SECRET_KEY,
	providerObserverToken: process.env.PROVIDER_OBSERVER_TOKEN,
	managementToken: process.env.GATEWAY_MANAGEMENT_TOKEN,
});

serve({ fetch: app.fetch, port, hostname: host });
process.stdout.write(`Veridex gateway '${config.id}' listening on http://${host}:${port}\n`);

export { createGatewayApp } from "./app.js";
export { validateGatewayConfig } from "./config.js";
export { InMemoryGatewayEventStore, JsonlGatewayEventStore } from "./store.js";
export type * from "./types.js";