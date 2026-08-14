/**
 * Veridex Bazaar Discovery Service - Main Entry Point
 * License: Apache-2.0
 *
 * Exports all public APIs for the Bazaar service.
 */

// Main service
export * from "./server.js";

// Database (aliased to avoid colliding with service/search configuration names)
export {
  Database,
  createDatabase,
  getDefaultConfig as getDefaultDatabaseConfig,
} from "./db/config.js";
export type { DatabaseConfig as PostgresDatabaseConfig } from "./db/config.js";

// P2P mesh
export * from "./p2p/index.js";

// Telemetry
export * from "./telemetry/index.js";

// Search
export * from "./search/index.js";

// Catalog
export * from "./catalog/index.js";

/**
 * CLI entry point for running the service
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const { startBazaarService } = await import("./server.js");

  console.log("Starting Veridex Bazaar Discovery Service...");
  console.log("Press Ctrl+C to stop");

  const service = await startBazaarService();

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\nReceived SIGINT, shutting down gracefully...");
    await service.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.log("\nReceived SIGTERM, shutting down gracefully...");
    await service.stop();
    process.exit(0);
  });
}
