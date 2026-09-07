import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { assertPublicAddress, validateGatewayConfig } from "../config.js";

function validConfig() {
  return {
    id: "gateway_test",
    upstream: "https://api.example.com",
    publicBaseUrl: "https://gateway.example.com",
    facilitatorUrl: "https://facilitator.example.com",
    payTo: Keypair.random().publicKey(),
    network: "stellar:testnet",
    asset: `C${"A".repeat(55)}`,
    price: "50000",
  };
}

describe("gateway configuration", () => {
  it("normalizes a valid exact testnet configuration", () => {
    expect(validateGatewayConfig(validConfig())).toMatchObject({
      upstream: "https://api.example.com",
      network: "stellar:testnet",
      state: "active",
      routePrefix: "/",
      maxRequestBodyBytes: 1024 * 1024,
    });
  });

  it.each([
    ["invalid URL", { upstream: "not-a-url" }],
    ["HTTP upstream", { upstream: "http://api.example.com" }],
    ["credentialed upstream", { upstream: "https://user:pass@api.example.com" }],
    ["invalid payTo", { payTo: "not-stellar" }],
    ["invalid asset", { asset: "native" }],
    ["invalid network", { network: "stellar:pubnet" }],
    ["zero price", { price: "0" }],
    ["decimal price", { price: "0.05" }],
    ["unlisted origin", { allowedUpstreamOrigins: ["https://other.example.com"] }],
    ["traversal route", { routes: [{ path: "/../admin" }] }],
  ])("rejects %s", (_label, override) => {
    expect(() => validateGatewayConfig({ ...validConfig(), ...override })).toThrow();
  });

  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "::1",
    "fd00::1",
    "fe80::1",
  ])("rejects private or reserved address %s", (address) => {
    expect(() => assertPublicAddress(address)).toThrow();
  });
});