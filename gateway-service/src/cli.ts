#!/usr/bin/env node

import { access, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { randomUUID } from "node:crypto";
import { validateGatewayConfig } from "./config.js";
import type { GatewayConfig } from "./types.js";

if (process.argv[2] !== "init") {
  stdout.write("Usage: veridex-gateway init [output-file]\n");
  process.exitCode = 1;
} else {
  await initializeConfig(process.argv[3] ?? "gateway.config.json");
}

async function initializeConfig(outputPath: string): Promise<void> {
  try {
    await access(outputPath);
    throw new Error(`${outputPath} already exists`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const upstream = await requiredAnswer(prompt, "Existing HTTPS API URL: ");
    const publicBaseUrl = await requiredAnswer(prompt, "Public gateway URL: ");
    const facilitatorUrl = await answerWithDefault(prompt, "Facilitator URL", "https://facilitator.veridex.network");
    const payTo = await requiredAnswer(prompt, "Seller payTo (G... or C...): ");
    const asset = await requiredAnswer(prompt, "SEP-41 asset contract (C...): ");
    const price = await requiredAnswer(prompt, "Price in atomic units: ");
    const name = await answerWithDefault(prompt, "Resource name", "My payable API");
    const description = await answerWithDefault(prompt, "Resource description", "API protected by Veridex Stellar x402");
    const tags = (await answerWithDefault(prompt, "Discovery tags (comma-separated)", "api,gateway"))
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);

    const config: GatewayConfig = validateGatewayConfig({
      id: `gateway_${randomUUID()}`,
      upstream,
      publicBaseUrl,
      facilitatorUrl,
      payTo,
      network: "stellar:testnet",
      asset,
      price,
      name,
      description,
      tags,
      state: "active",
      routes: [{ path: "/*", methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] }],
    });
    await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    stdout.write(`\nCreated ${outputPath}. Start with GATEWAY_CONFIG=${outputPath} npm start.\n`);
  } finally {
    prompt.close();
  }
}

async function requiredAnswer(
  prompt: ReturnType<typeof createInterface>,
  message: string,
): Promise<string> {
  const value = (await prompt.question(message)).trim();
  if (!value) throw new Error("A required answer was empty");
  return value;
}

async function answerWithDefault(
  prompt: ReturnType<typeof createInterface>,
  label: string,
  fallback: string,
): Promise<string> {
  return (await prompt.question(`${label} [${fallback}]: `)).trim() || fallback;
}