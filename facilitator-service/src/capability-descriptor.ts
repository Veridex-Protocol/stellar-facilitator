/**
 * Veridex Facilitator Service - Capability Descriptor (x402ccd/0)
 * License: Apache-2.0
 *
 * Serves `/.well-known/x402` per extension proposal #3117.
 *
 * The descriptor is a machine-readable list of what a client can buy here. It
 * previously carried two hardcoded example jobs (`oracle/read`,
 * `compute/session`) against a hardcoded hostname, which meant every
 * deployment advertised two endpoints it did not serve. Jobs now come from
 * configuration, are validated against what this deployment actually
 * advertises, and default to none.
 */

import { StrKey } from "@stellar/stellar-sdk";
import { readFileSync } from "node:fs";
import { z } from "zod";

/** A single purchasable job, as advertised in the descriptor. */
const JobSchema = z.object({
  id: z.string().min(1).max(64),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().startsWith("/"),
  price: z.object({
    /** SEP-41 token contract address the price is denominated in. */
    asset: z.string().refine(StrKey.isValidContract, {
      message: "price.asset must be a SEP-41 token contract address (C...)",
    }),
    /** Human-facing label for that contract, e.g. "USDC". Never used for settlement. */
    assetCode: z.string().max(12).optional(),
    amountAtomic: z.string().regex(/^\d+$/, "amountAtomic must be digits in the asset's atomic units"),
    decimals: z.number().int().min(0).max(38),
    network: z.string().includes(":"),
    scheme: z.string().min(1),
    payTo: z.string().refine((value) => StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value), {
      message: "price.payTo must be a Stellar account (G...) or contract (C...) address",
    }),
  }),
  verification: z.object({
    kind: z.enum(["chain-provenance", "recompute", "attested-tee", "none"]),
    detail: z.string().min(1),
  }),
});

export type CapabilityJob = z.infer<typeof JobSchema>;

const JobsFileSchema = z.object({ jobs: z.array(JobSchema) });

export interface DescriptorInput {
  baseUrl: string;
  network: string;
  receiptSigner: string;
  /** Schemes this deployment actually advertises on `/supported`. */
  advertisedSchemes: string[];
  jobs: CapabilityJob[];
}

/**
 * Loads and validates the job list backing the descriptor.
 *
 * A job is only advertised when it is denominated on the network this
 * deployment serves and priced in a scheme this deployment advertises.
 * Anything else is a configuration error and fails the boot, because a
 * descriptor pointing at a scheme we do not implement is worse than an empty
 * one.
 *
 * @param options - Where to read jobs from, and what they must agree with
 * @returns The validated jobs, or an empty list when no file is configured
 * @throws {Error} When the file is unreadable, malformed, or disagrees with this deployment
 */
export function loadCapabilityJobs(options: {
  jobsFile?: string;
  network: string;
  advertisedSchemes: string[];
}): CapabilityJob[] {
  if (!options.jobsFile) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(options.jobsFile, "utf8"));
  } catch (error: any) {
    throw new Error(
      `X402_JOBS_FILE '${options.jobsFile}' could not be read as JSON: ${error?.message ?? String(error)}`,
    );
  }

  const parsed = JobsFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `X402_JOBS_FILE '${options.jobsFile}' is not a valid job list: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  for (const job of parsed.data.jobs) {
    if (job.price.network !== options.network) {
      throw new Error(
        `job '${job.id}' is priced on ${job.price.network} but this facilitator serves ${options.network}`,
      );
    }
    if (!options.advertisedSchemes.includes(job.price.scheme)) {
      throw new Error(
        `job '${job.id}' is priced in the '${job.price.scheme}' scheme, which this facilitator does not advertise (advertised: ${options.advertisedSchemes.join(", ") || "none"})`,
      );
    }
  }

  return parsed.data.jobs;
}

/**
 * Builds the `x402ccd/0` capability descriptor body.
 *
 * @param input - Deployment facts and validated jobs
 * @returns The descriptor to serve at `/.well-known/x402`
 */
export function buildCapabilityDescriptor(input: DescriptorInput): Record<string, unknown> {
  return {
    ccd: "x402ccd/0",
    service: "Veridex x402 Facilitator",
    baseUrl: input.baseUrl,
    network: input.network,
    runtime: {
      // Honesty rule from #3117: this stays false until a verifiable TEE
      // attestation is actually produced per job. It never has been here.
      attested: false,
      platform: "stellar-soroban",
      note: "Settlement is verifiable from the Stellar ledger. No TEE attestation is produced by this deployment.",
    },
    receipts: {
      format: "x402job/1",
      signer: input.receiptSigner,
      canonicalization: "RFC8785",
      note: "Ed25519 signature over the RFC 8785 canonical JSON of the claims. Request and result digests are SHA-256 over the same canonical form, so a third party can recompute both from the exact bytes exchanged.",
    },
    schemes: input.advertisedSchemes,
    jobs: input.jobs,
  };
}
