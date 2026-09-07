import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlGatewayEventStore } from "../store.js";
import type { ProviderOutcomeRecord, VeridexPaymentEvent } from "../types.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("JSONL gateway event store", () => {
  it("reloads settlement and provider records across store instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "veridex-gateway-"));
    directories.push(directory);
    const event = {
      schemaVersion: "veridex.payment-event/v1",
      paymentId: "payment-1",
      resourceId: "resource-1",
      resourceUrl: "https://gateway.example.com/data",
      scheme: "exact",
      network: "stellar:testnet",
      asset: `C${"A".repeat(55)}`,
      payTo: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      gatewayFee: "0",
      feeDetermination: "not_charged",
      status: "settled",
      gatewayId: "gateway-1",
      createdAt: new Date().toISOString(),
      transactionHash: "a".repeat(64),
    } satisfies VeridexPaymentEvent;
    const outcome = {
      schemaVersion: "veridex.provider-outcome-record/v1",
      paymentId: "payment-1",
      gatewayId: "gateway-1",
      resourceId: "resource-1",
      requestId: "request-1",
      usable: true,
      providerAtFault: false,
      attributable: "unknown",
      reasonCode: "ok",
      observedAt: new Date().toISOString(),
    } satisfies ProviderOutcomeRecord;

    const first = new JsonlGatewayEventStore(directory);
    await first.appendPaymentEvent(event);
    await first.appendProviderOutcome(outcome);
    const reloaded = new JsonlGatewayEventStore(directory);

    expect(await reloaded.findSettlement("payment-1")).toMatchObject({ transactionHash: "a".repeat(64) });
    expect(await reloaded.listProviderOutcomes("gateway-1")).toEqual([outcome]);
  });
});