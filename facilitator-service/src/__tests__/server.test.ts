import { describe, expect, it } from "vitest";
import { FacilitatorService } from "../server.js";
import { makeConfig, recordingLogger } from "./helpers.js";

const ASSET = "CC7AMNLQWIEKWMSGKXC7DFEXHDTNMQ6JL2BBPRBM6RQXYZXCNKD75CVB";
const PAY_TO = "GCNNJJV3XUXWCVV3WBKILBCUUGKSDZ2BL4HHNV7AISYMW6PJQX47DZYU";

describe("canonical facilitator HTTP surface", () => {
  it("advertises the x402 v2 exact Stellar kind and signer", async () => {
    const { config, signer } = makeConfig();
    const service = new FacilitatorService(config, recordingLogger().logger);

    const response = await service.getApp().request("/supported");
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.kinds).toEqual([
      expect.objectContaining({
        x402Version: 2,
        scheme: "exact",
        network: "stellar:testnet",
        extra: expect.objectContaining({ areFeesSponsored: expect.any(Boolean) }),
      }),
    ]);
    expect(body.signers["stellar:*"]).toContain(signer.publicKey());
  });

  it("does not advertise upto until a contract has been confirmed on-chain", async () => {
    // Before this gate existed, /supported carried an 'upto' kind whose
    // contractId fell back to the literal string 'upto_escrow_v1'.
    const { config } = makeConfig();
    const service = new FacilitatorService(config, recordingLogger().logger);

    const body = (await (await service.getApp().request("/supported")).json()) as any;

    expect(body.kinds.map((kind: any) => kind.scheme)).not.toContain("upto");
    expect(JSON.stringify(body)).not.toContain("upto_escrow_v1");
  });

  it("does not claim fee sponsorship before the funding check has run", async () => {
    const { config } = makeConfig();
    const service = new FacilitatorService(config, recordingLogger().logger);

    const body = (await (await service.getApp().request("/supported")).json()) as any;
    const exact = body.kinds.find((kind: any) => kind.scheme === "exact");

    expect(exact.extra.areFeesSponsored).toBe(false);
    expect(service.getCapabilities().checked).toBe(false);
  });

  it("serves a capability descriptor with no invented jobs or hosts", async () => {
    const { config, signer } = makeConfig({ baseUrl: "https://facilitator.example" });
    const service = new FacilitatorService(config, recordingLogger().logger);

    const body = (await (await service.getApp().request("/.well-known/x402")).json()) as any;

    expect(body.ccd).toBe("x402ccd/0");
    expect(body.baseUrl).toBe("https://facilitator.example");
    expect(body.jobs).toEqual([]);
    expect(body.runtime.attested).toBe(false);
    expect(body.receipts.signer).toBe(signer.publicKey());
    // The two placeholder jobs that used to be hardcoded here.
    expect(JSON.stringify(body)).not.toContain("oracle/read");
    expect(JSON.stringify(body)).not.toContain("compute/session");
    expect(JSON.stringify(body)).not.toContain("facilitator.veridex.io");
  });

  it("rejects a malformed verification request with a code and a sentence", async () => {
    const { config } = makeConfig();
    const service = new FacilitatorService(config, recordingLogger().logger);

    const response = await service.getApp().request("/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.isValid).toBe(false);
    expect(body.invalidReason).toBe("invalid_request_body");
    expect(body.invalidMessage.length).toBeGreaterThan(20);
  });

  it("names the offending field when the asset is a classic identifier", async () => {
    const { config } = makeConfig();
    const service = new FacilitatorService(config, recordingLogger().logger);

    const response = await service.getApp().request("/settle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentPayload: {
          x402Version: 2,
          accepted: {},
          payload: { transaction: "AAAAAg==" },
        },
        paymentRequirements: {
          scheme: "exact",
          network: "stellar:testnet",
          asset: "native",
          amount: "50000",
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,
        },
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.errorReason).toBe("invalid_request_body");
    expect(body.errorMessage).toMatch(/SEP-41 token contract address/);
    expect(body.transaction).toBe("");
  });

  it("logs one structured outcome line per request, with latency", async () => {
    const { config } = makeConfig();
    const { logger, lines } = recordingLogger();
    const service = new FacilitatorService(config, logger);

    await service.getApp().request("/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    const outcomes = lines.filter((line) => line.kind === "request_outcome");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ endpoint: "/verify", outcome: "invalid", status: 400 });
    expect(typeof outcomes[0].latencyMs).toBe("number");
  });

  it("rate limits before it will spend fees on an unbounded request rate", async () => {
    const { config } = makeConfig({ rateLimit: { windowMs: 60_000, max: 2 } });
    const service = new FacilitatorService(config, recordingLogger().logger);
    const app = service.getApp();

    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/health")).status).toBe(200);

    const limited = await app.request("/health");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    expect((await limited.json()) as any).toMatchObject({ error: "rate_limited" });
  });

  it("rejects a body larger than a payment envelope could be", async () => {
    const { config } = makeConfig();
    const service = new FacilitatorService(config, recordingLogger().logger);

    const response = await service.getApp().request("/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(300 * 1024) }),
    });

    expect(response.status).toBe(413);
  });

  it("answers an unknown endpoint with a usable message", async () => {
    const { config } = makeConfig();
    const service = new FacilitatorService(config, recordingLogger().logger);

    const response = await service.getApp().request("/nope");
    expect(response.status).toBe(404);
    expect((await response.json()) as any).toMatchObject({ error: "not_found" });
  });

  it("reports what it has and has not confirmed on /health", async () => {
    const { config, signer } = makeConfig();
    const service = new FacilitatorService(config, recordingLogger().logger);

    const body = (await (await service.getApp().request("/health")).json()) as any;
    expect(body).toMatchObject({
      status: "ok",
      network: "stellar:testnet",
      facilitator: signer.publicKey(),
      areFeesSponsored: false,
      startupChecksPassed: false,
    });
  });

  it("says on /stats that its counters cannot back a published figure", async () => {
    const { config } = makeConfig();
    const service = new FacilitatorService(config, recordingLogger().logger);

    const body = (await (await service.getApp().request("/stats")).json()) as any;
    expect(body.note).toMatch(/reset on restart/);
    expect(body.ledgerSkew).toMatchObject({ retriesIssued: 0, recoveredAfterRetry: 0 });
  });
});

describe("startup checks", () => {
  it("refuses to start when it would advertise sponsorship from an unfunded account", async () => {
    // makeConfig() generates a fresh keypair, so the account does not exist.
    const { config } = makeConfig({ intendToSponsorFees: true });
    const service = new FacilitatorService(config, recordingLogger().logger);

    await expect(service.runStartupChecks()).rejects.toThrow(
      /configured to sponsor network fees, but its account .* does not exist on this network/,
    );
  }, 30_000);

  it("starts without sponsorship when configured not to sponsor", async () => {
    const { config } = makeConfig({ intendToSponsorFees: false });
    const service = new FacilitatorService(config, recordingLogger().logger);

    await service.runStartupChecks();

    expect(service.getCapabilities()).toMatchObject({ feesAreSponsored: false, checked: true });
    const body = (await (await service.getApp().request("/supported")).json()) as any;
    expect(body.kinds[0].extra.areFeesSponsored).toBe(false);
    expect(body.kinds.map((kind: any) => kind.scheme)).not.toContain("upto");
  }, 30_000);

  it("refuses to start when the public key is not the secret key's", async () => {
    const { config } = makeConfig();
    config.stellar.facilitatorPublicKey = PAY_TO;
    const service = new FacilitatorService(config, recordingLogger().logger);

    await expect(service.runStartupChecks()).rejects.toThrow(/is not the public key of/);
  });
});

describe("configuration", () => {
  it("refuses to build a configuration without a public base URL", async () => {
    const { getDefaultConfig } = await import("../server.js");
    const saved = process.env.BASE_URL;
    delete process.env.BASE_URL;
    try {
      expect(() => getDefaultConfig()).toThrow(/BASE_URL is required/);
    } finally {
      if (saved !== undefined) process.env.BASE_URL = saved;
    }
  });
});

// Keeps the unused-import lint quiet while documenting the asset used above.
void ASSET;
