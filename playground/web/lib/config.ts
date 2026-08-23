/**
 * Playground configuration, fetched from the server at boot.
 * License: Apache-2.0
 */

export interface PlaygroundConfig {
  facilitatorUrl: string;
  demoServerUrl: string;
  bazaarUrl: string;
  network: string;
  horizonUrl: string;
  rpcUrl: string;
  friendbotUrl: string;
  explorerTxUrl: string;
  paidResourceUrl: string;
  paymentAsset: string;
}

let cached: PlaygroundConfig | undefined;

/**
 * Loads configuration once per page load.
 *
 * @returns The playground configuration
 * @throws {Error} When the server cannot be reached
 */
export async function loadConfig(): Promise<PlaygroundConfig> {
  if (cached) return cached;
  const response = await fetch("/api/config");
  if (!response.ok) throw new Error(`/api/config returned HTTP ${response.status}`);
  cached = (await response.json()) as PlaygroundConfig;
  return cached;
}
