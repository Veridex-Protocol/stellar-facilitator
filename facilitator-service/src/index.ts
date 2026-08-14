/**
 * Veridex Facilitator Service - Main Entry Point
 * License: Apache-2.0
 *
 * Exports all public APIs for the Facilitator service.
 */

// Main service
export * from "./server.js";

// Channel pool
export * from "./channel/index.js";

// Stellar integration
export * from "./stellar/index.js";

/**
 * CLI entry point for running the service
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const { startFacilitatorService } = await import("./server.js");

  console.log("Starting Veridex x402 Facilitator Service...");
  console.log("Press Ctrl+C to stop");

  const service = await startFacilitatorService();

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
