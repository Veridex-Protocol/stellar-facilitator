import { describe, expect, it } from "vitest";
import { validateFacilitatorRequest } from "../validation.js";

const ASSET = "CC7AMNLQWIEKWMSGKXC7DFEXHDTNMQ6JL2BBPRBM6RQXYZXCNKD75CVB";
const PAY_TO = "GCNNJJV3XUXWCVV3WBKILBCUUGKSDZ2BL4HHNV7AISYMW6PJQX47DZYU";

const REQUIREMENTS = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: ASSET,
  amount: "50000",
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
};

const PAYLOAD = {
  x402Version: 2,
  accepted: REQUIREMENTS,
  payload: { transaction: "AAAAAgAAAABase64Envelope" },
};

describe("request envelope validation", () => {
  it("accepts a well-formed request", () => {
    expect(
      validateFacilitatorRequest({ paymentPayload: PAYLOAD, paymentRequirements: REQUIREMENTS }),
    ).toBeNull();
  });

  it("names the missing half of the envelope", () => {
    expect(validateFacilitatorRequest({})).toMatch(/'paymentPayload' must be an object/);
    expect(validateFacilitatorRequest({ paymentPayload: PAYLOAD })).toMatch(
      /'paymentRequirements' must be an object/,
    );
  });

  it("rejects a classic asset identifier with an explanation", () => {
    const message = validateFacilitatorRequest({
      paymentPayload: PAYLOAD,
      paymentRequirements: { ...REQUIREMENTS, asset: "native" },
    });
    expect(message).toMatch(/SEP-41 token contract address/);
    expect(message).toMatch(/not valid in x402 v2/);
  });

  it("rejects a non-atomic amount", () => {
    expect(
      validateFacilitatorRequest({
        paymentPayload: PAYLOAD,
        paymentRequirements: { ...REQUIREMENTS, amount: "0.005" },
      }),
    ).toMatch(/must be a string of digits/);
  });

  it("rejects a payTo that is not a Stellar address", () => {
    expect(
      validateFacilitatorRequest({
        paymentPayload: PAYLOAD,
        paymentRequirements: { ...REQUIREMENTS, payTo: "0xdeadbeef" },
      }),
    ).toMatch(/must be a Stellar address/);
  });

  it("rejects a missing signed transaction", () => {
    expect(
      validateFacilitatorRequest({
        paymentPayload: { ...PAYLOAD, payload: {} },
        paymentRequirements: REQUIREMENTS,
      }),
    ).toMatch(/must be the base64-encoded signed Stellar transaction/);
  });

  it("accepts a contract address as payTo", () => {
    expect(
      validateFacilitatorRequest({
        paymentPayload: PAYLOAD,
        paymentRequirements: { ...REQUIREMENTS, payTo: ASSET },
      }),
    ).toBeNull();
  });

  it("rejects a non-object body", () => {
    expect(validateFacilitatorRequest(undefined)).toMatch(/must be a JSON object/);
    expect(validateFacilitatorRequest("{}")).toMatch(/must be a JSON object/);
  });
});
