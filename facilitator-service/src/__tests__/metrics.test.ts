import { describe, expect, it } from "vitest";
import { FacilitatorService } from "../server.js";
import { makeConfig, recordingLogger } from "./helpers.js";

const ASSET = "CC7AMNLQWIEKWMSGKXC7DFEXHDTNMQ6JL2BBPRBM6RQXYZXCNKD75CVB";
const PAY_TO = "GCNNJJV3XUXWCVV3WBKILBCUUGKSDZ2BL4HHNV7AISYMW6PJQX47DZYU";

describe("facilitator Prometheus metrics", () => {
  it("exports required metrics and records accepted verification work", async () => {
    const { config } = makeConfig();
    const service = new FacilitatorService(config, recordingLogger().logger);
    const requirements = {
      scheme: "exact",
      network: "stellar:testnet",
      asset: ASSET,
      amount: "100000",
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra: {},
    };

    await service.getApp().request("/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentPayload: {
          x402Version: 2,
          accepted: requirements,
          payload: { transaction: "AAAAAg==" },
        },
        paymentRequirements: requirements,
      }),
    });

    const response = await service.getApp().request("/metrics");
    const text = await response.text();
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(text).toContain("# TYPE veridex_verifications_total counter");
    expect(text).toContain("veridex_verifications_total 1");
    expect(text).toContain("veridex_rpc_requests_total 1");
    expect(text).toContain("# TYPE veridex_settlement_latency histogram");
    expect(text).toContain("veridex_settlement_latency_bucket{le=\"+Inf\"}");
    for (const name of [
      "veridex_settlements_total",
      "veridex_settlement_failures_total",
      "veridex_sponsored_fee_total",
      "veridex_channel_available",
      "veridex_channel_in_use",
      "veridex_channel_quarantined",
      "veridex_channel_sequence_drift",
      "veridex_rpc_failures_total",
      "veridex_rpc_disagreements_total",
    ]) {
      expect(text).toContain(`# HELP ${name} `);
    }
  });
});