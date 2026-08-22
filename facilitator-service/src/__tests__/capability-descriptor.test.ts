import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCapabilityDescriptor, loadCapabilityJobs } from "../capability-descriptor.js";

const ASSET = "CC7AMNLQWIEKWMSGKXC7DFEXHDTNMQ6JL2BBPRBM6RQXYZXCNKD75CVB";
const PAY_TO = "GCNNJJV3XUXWCVV3WBKILBCUUGKSDZ2BL4HHNV7AISYMW6PJQX47DZYU";

const dirs: string[] = [];

/**
 * Writes a jobs file to a temporary directory.
 *
 * @param content - The JSON content to write
 * @returns Path to the written file
 */
function jobsFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "veridex-jobs-"));
  dirs.push(dir);
  const path = join(dir, "jobs.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const VALID_JOB = {
  id: "oracle/read",
  method: "POST",
  path: "/oracle/read",
  price: {
    asset: ASSET,
    assetCode: "USDC",
    amountAtomic: "50000",
    decimals: 6,
    network: "stellar:testnet",
    scheme: "exact",
    payTo: PAY_TO,
  },
  verification: { kind: "chain-provenance", detail: "Re-query the oracle or the ledger to reproduce." },
};

describe("capability descriptor jobs", () => {
  it("advertises no jobs when none are configured", () => {
    expect(
      loadCapabilityJobs({ network: "stellar:testnet", advertisedSchemes: ["exact"] }),
    ).toEqual([]);
  });

  it("loads a valid job list", () => {
    const jobs = loadCapabilityJobs({
      jobsFile: jobsFile({ jobs: [VALID_JOB] }),
      network: "stellar:testnet",
      advertisedSchemes: ["exact"],
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe("oracle/read");
  });

  it("refuses a job priced in a scheme this deployment does not advertise", () => {
    // This is the guard that would have caught the hardcoded 'compute/session'
    // job advertising the 'upto' scheme while no upto contract was deployed.
    const upto = { ...VALID_JOB, id: "compute/session", price: { ...VALID_JOB.price, scheme: "upto" } };
    expect(() =>
      loadCapabilityJobs({
        jobsFile: jobsFile({ jobs: [upto] }),
        network: "stellar:testnet",
        advertisedSchemes: ["exact"],
      }),
    ).toThrow(/is priced in the 'upto' scheme, which this facilitator does not advertise/);
  });

  it("refuses a job priced on another network", () => {
    const pubnet = { ...VALID_JOB, price: { ...VALID_JOB.price, network: "stellar:pubnet" } };
    expect(() =>
      loadCapabilityJobs({
        jobsFile: jobsFile({ jobs: [pubnet] }),
        network: "stellar:testnet",
        advertisedSchemes: ["exact"],
      }),
    ).toThrow(/is priced on stellar:pubnet but this facilitator serves stellar:testnet/);
  });

  it("refuses a price denominated in a symbol rather than a token contract", () => {
    const symbolic = { ...VALID_JOB, price: { ...VALID_JOB.price, asset: "USDC" } };
    expect(() =>
      loadCapabilityJobs({
        jobsFile: jobsFile({ jobs: [symbolic] }),
        network: "stellar:testnet",
        advertisedSchemes: ["exact"],
      }),
    ).toThrow(/SEP-41 token contract address/);
  });

  it("reports an unreadable jobs file rather than serving an empty descriptor", () => {
    expect(() =>
      loadCapabilityJobs({
        jobsFile: "/nonexistent/jobs.json",
        network: "stellar:testnet",
        advertisedSchemes: ["exact"],
      }),
    ).toThrow(/could not be read as JSON/);
  });
});

describe("capability descriptor body", () => {
  const descriptor = buildCapabilityDescriptor({
    baseUrl: "https://facilitator.example",
    network: "stellar:testnet",
    receiptSigner: PAY_TO,
    advertisedSchemes: ["exact"],
    jobs: [],
  }) as any;

  it("never claims an attested runtime", () => {
    // The #3117 honesty rule: false unless a verifiable TEE claim is present.
    expect(descriptor.runtime.attested).toBe(false);
  });

  it("names the canonicalization a verifier needs to recompute receipts", () => {
    expect(descriptor.receipts.canonicalization).toBe("RFC8785");
    expect(descriptor.receipts.signer).toBe(PAY_TO);
  });

  it("carries the configured base URL rather than a hardcoded host", () => {
    expect(descriptor.baseUrl).toBe("https://facilitator.example");
  });

  it("advertises no jobs when none are configured", () => {
    expect(descriptor.jobs).toEqual([]);
  });
});
