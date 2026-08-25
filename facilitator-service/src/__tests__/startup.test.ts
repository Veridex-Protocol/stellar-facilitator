import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  assertSignerKeypairConsistent,
  assertSupportedIsTruthful,
  resolveUptoGate,
  type SupportedKind,
} from "../startup.js";

const SIGNER = Keypair.random().publicKey();
const NETWORK = "stellar:testnet";

/**
 * Builds a `/supported` body for the assertions below.
 *
 * @param kinds - Kinds to advertise
 * @returns A supported response
 */
function supported(kinds: SupportedKind[]) {
  return { kinds, signers: { "stellar:*": [SIGNER] } };
}

const EXACT_SPONSORED: SupportedKind = {
  x402Version: 2,
  scheme: "exact",
  network: NETWORK,
  extra: { areFeesSponsored: true },
};

describe("signer keypair consistency", () => {
  it("accepts a matching pair", () => {
    const keypair = Keypair.random();
    expect(() =>
      assertSignerKeypairConsistent(keypair.secret(), keypair.publicKey()),
    ).not.toThrow();
  });

  it("rejects a public key that is not derived from the secret", () => {
    expect(() =>
      assertSignerKeypairConsistent(Keypair.random().secret(), Keypair.random().publicKey()),
    ).toThrow(/is not the public key of/);
  });

  it("rejects a missing or malformed secret", () => {
    expect(() => assertSignerKeypairConsistent("", SIGNER)).toThrow(/required/);
    expect(() => assertSignerKeypairConsistent("not-a-key", SIGNER)).toThrow(/valid Stellar secret key/);
  });
});

describe("/supported truthfulness gate", () => {
  it("passes when the advertised facts match the deployment", () => {
    expect(() =>
      assertSupportedIsTruthful(supported([EXACT_SPONSORED]), {
        network: NETWORK,
        feesAreSponsored: true,
        signerAddress: SIGNER,
      }),
    ).not.toThrow();
  });

  it("refuses to advertise fee sponsorship the deployment does not provide", () => {
    expect(() =>
      assertSupportedIsTruthful(supported([EXACT_SPONSORED]), {
        network: NETWORK,
        feesAreSponsored: false,
        signerAddress: SIGNER,
      }),
    ).toThrow(/advertises areFeesSponsored=true but this deployment sponsors fees=false/);
  });

  it("refuses to advertise upto without a confirmed contract", () => {
    const withUpto = supported([
      EXACT_SPONSORED,
      { x402Version: 2, scheme: "upto", network: NETWORK, extra: { contractId: "upto_escrow_v1" } },
    ]);
    expect(() =>
      assertSupportedIsTruthful(withUpto, {
        network: NETWORK,
        feesAreSponsored: true,
        signerAddress: SIGNER,
      }),
    ).toThrow(/advertises the 'upto' scheme but no deployed upto contract was confirmed/);
  });

  it("refuses to advertise an upto contract id other than the confirmed one", () => {
    const confirmed = "CC7AMNLQWIEKWMSGKXC7DFEXHDTNMQ6JL2BBPRBM6RQXYZXCNKD75CVB";
    const withUpto = supported([
      EXACT_SPONSORED,
      { x402Version: 2, scheme: "upto", network: NETWORK, extra: { contractId: "something-else" } },
    ]);
    expect(() =>
      assertSupportedIsTruthful(withUpto, {
        network: NETWORK,
        feesAreSponsored: true,
        uptoContractId: confirmed,
        signerAddress: SIGNER,
      }),
    ).toThrow(/but the confirmed deployment is/);
  });

  it("requires the exact scheme to be present", () => {
    expect(() =>
      assertSupportedIsTruthful(supported([]), {
        network: NETWORK,
        feesAreSponsored: false,
        signerAddress: SIGNER,
      }),
    ).toThrow(/does not advertise the 'exact' scheme/);
  });

  it("requires areFeesSponsored to be a boolean, not absent", () => {
    expect(() =>
      assertSupportedIsTruthful(
        supported([{ x402Version: 2, scheme: "exact", network: NETWORK, extra: {} }]),
        { network: NETWORK, feesAreSponsored: false, signerAddress: SIGNER },
      ),
    ).toThrow(/must carry a boolean 'extra.areFeesSponsored'/);
  });

  it("requires the configured signer to be listed", () => {
    expect(() =>
      assertSupportedIsTruthful(supported([EXACT_SPONSORED]), {
        network: NETWORK,
        feesAreSponsored: true,
        signerAddress: Keypair.random().publicKey(),
      }),
    ).toThrow(/does not list the configured signer/);
  });
});

describe("upto contract gate", () => {
  it("does not advertise when no contract id is configured", async () => {
    const gate = await resolveUptoGate("testnet", "https://soroban-testnet.stellar.org", {});
    expect(gate.advertise).toBe(false);
    expect(gate.reason).toMatch(/no upto contract configured for testnet/);
  });

  it("rejects a placeholder id that is not a contract address", async () => {
    // This is the exact value that used to be advertised.
    const gate = await resolveUptoGate("testnet", "https://soroban-testnet.stellar.org", {
      UPTO_ESCROW_CONTRACT_ID: "upto_escrow_v1",
    });
    expect(gate.advertise).toBe(false);
    expect(gate.reason).toMatch(/is not a Stellar contract address/);
  });

  it("does not inherit a testnet contract id onto pubnet", async () => {
    const gate = await resolveUptoGate("pubnet", "https://mainnet.sorobanrpc.com", {
      UPTO_ESCROW_CONTRACT_ID_TESTNET: "CC7AMNLQWIEKWMSGKXC7DFEXHDTNMQ6JL2BBPRBM6RQXYZXCNKD75CVB",
    });
    expect(gate.advertise).toBe(false);
    expect(gate.reason).toMatch(/no upto contract configured for pubnet/);
  });

  it("does not advertise when the contract cannot be confirmed on-chain", async () => {
    const gate = await resolveUptoGate("testnet", "http://127.0.0.1:1/unreachable", {
      UPTO_ESCROW_CONTRACT_ID_TESTNET: "CC7AMNLQWIEKWMSGKXC7DFEXHDTNMQ6JL2BBPRBM6RQXYZXCNKD75CVB",
    });
    expect(gate.advertise).toBe(false);
    expect(gate.reason).toMatch(/could not confirm a contract is deployed/);
  });
});
