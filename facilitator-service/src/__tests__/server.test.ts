import { describe, expect, it } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { FacilitatorService } from "../server.js";

describe("canonical facilitator HTTP surface", () => {
  it("advertises the x402 v2 exact Stellar kind and signer", async () => {
    const signer = Keypair.random();
    const service = new FacilitatorService({
      host: "127.0.0.1",
      port: 0,
      stellar: {
        network: "testnet",
        networkPassphrase: Networks.TESTNET,
        horizonUrl: "https://horizon-testnet.stellar.org",
        rpcUrl: "https://soroban-testnet.stellar.org",
        facilitatorPublicKey: signer.publicKey(),
        facilitatorSecretKey: signer.secret(),
      },
      channelPool: {
        poolSize: 0,
        sourceSecretKey: signer.secret(),
        networkPassphrase: Networks.TESTNET,
        horizonUrl: "https://horizon-testnet.stellar.org",
      },
    });

    const response = await service.getApp().request("/supported");
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.kinds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          x402Version: 2,
          scheme: "exact",
          network: "stellar:testnet",
          extra: expect.objectContaining({ areFeesSponsored: true }),
        }),
        expect.objectContaining({
          x402Version: 2,
          scheme: "upto",
          network: "stellar:testnet",
        }),
      ])
    );
    expect(body.signers["stellar:*"]).toContain(signer.publicKey());
  });

  it("rejects a malformed canonical verification request", async () => {
    const signer = Keypair.random();
    const service = new FacilitatorService({
      host: "127.0.0.1",
      port: 0,
      stellar: {
        network: "testnet",
        networkPassphrase: Networks.TESTNET,
        horizonUrl: "https://horizon-testnet.stellar.org",
        rpcUrl: "https://soroban-testnet.stellar.org",
        facilitatorPublicKey: signer.publicKey(),
        facilitatorSecretKey: signer.secret(),
      },
      channelPool: { poolSize: 0, sourceSecretKey: signer.secret() },
    });

    const response = await service.getApp().request("/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      isValid: false,
      invalidReason: "invalid_request",
    });
  });
});
