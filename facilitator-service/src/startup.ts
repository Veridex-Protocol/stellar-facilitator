/**
 * Veridex Facilitator Service - Startup Self-Checks
 * License: Apache-2.0
 *
 * Everything this service advertises on `/supported` and `/.well-known/x402`
 * is a promise to a client that has not met us. These checks run before the
 * HTTP server binds, and they fail the boot rather than let a running
 * deployment advertise something that is not true of it.
 *
 * The three things that can quietly become false:
 *
 *  1. `areFeesSponsored: true` - true only while the sponsoring account exists
 *     and holds enough XLM to pay Soroban resource fees.
 *  2. `scheme: "upto"` - true only while a real contract is deployed at the
 *     configured id on the network we are serving.
 *  3. the receipt signer - true only while we hold the secret key for the
 *     address we publish.
 */

import { Horizon, Keypair, StrKey, rpc as SorobanRpc, xdr } from "@stellar/stellar-sdk";

/** Minimum sponsor balance, in XLM, below which we refuse to claim fee sponsorship. */
export const MIN_SPONSOR_BALANCE_XLM = 5;

export interface FundingCheckResult {
  funded: boolean;
  balanceXlm: string;
  reason?: string;
}

/**
 * Reads the native balance of the fee-sponsoring account.
 *
 * @param horizonUrl - Horizon endpoint for the configured network
 * @param publicKey - The account that will be the source of every settlement
 * @returns Whether the account can sponsor fees, and the balance observed
 */
export async function checkSponsorFunding(
  horizonUrl: string,
  publicKey: string,
): Promise<FundingCheckResult> {
  if (!StrKey.isValidEd25519PublicKey(publicKey)) {
    return { funded: false, balanceXlm: "0", reason: `'${publicKey}' is not a Stellar account address` };
  }

  try {
    const account = await new Horizon.Server(horizonUrl).loadAccount(publicKey);
    const native = account.balances.find((balance) => balance.asset_type === "native");
    const balanceXlm = native?.balance ?? "0";

    if (Number(balanceXlm) < MIN_SPONSOR_BALANCE_XLM) {
      return {
        funded: false,
        balanceXlm,
        reason: `holds ${balanceXlm} XLM, below the ${MIN_SPONSOR_BALANCE_XLM} XLM required to sponsor fees`,
      };
    }
    return { funded: true, balanceXlm };
  } catch (error: any) {
    if (error?.response?.status === 404) {
      return {
        funded: false,
        balanceXlm: "0",
        reason: "the account does not exist on this network (it has never been funded)",
      };
    }
    return {
      funded: false,
      balanceXlm: "0",
      reason: `Horizon could not be reached to confirm funding: ${error?.message ?? String(error)}`,
    };
  }
}

/**
 * Confirms the facilitator holds the secret key for the address it publishes.
 *
 * @param secretKey - Configured secret key
 * @param publicKey - Configured public key
 * @throws {Error} When the key is missing, malformed, or does not derive the public key
 */
export function assertSignerKeypairConsistent(secretKey: string, publicKey: string): void {
  if (!secretKey) {
    throw new Error("FACILITATOR_SECRET_KEY is required");
  }
  let derived: string;
  try {
    derived = Keypair.fromSecret(secretKey).publicKey();
  } catch {
    throw new Error("FACILITATOR_SECRET_KEY is not a valid Stellar secret key (S...)");
  }
  if (publicKey && derived !== publicKey) {
    throw new Error(
      `FACILITATOR_PUBLIC_KEY (${publicKey}) is not the public key of FACILITATOR_SECRET_KEY (${derived})`,
    );
  }
}

export interface UptoGateResult {
  /** Whether `upto` may be advertised on `/supported`. */
  advertise: boolean;
  contractId?: string;
  /** Why it is not being advertised, for the boot log. */
  reason?: string;
}

/**
 * Decides whether the `upto` scheme may be advertised.
 *
 * `upto` is a real scheme only when a real contract backs it. This resolves the
 * contract id for the network being served and confirms the contract instance
 * exists on-chain. Anything less - unset, malformed, or not deployed - and the
 * scheme stays out of `/supported` entirely rather than being advertised
 * against a placeholder id.
 *
 * @param network - `testnet` or `pubnet`
 * @param rpcUrl - Soroban RPC endpoint for that network
 * @param env - Environment to read the contract id from
 * @returns Whether to advertise, and the contract id when so
 */
export async function resolveUptoGate(
  network: "testnet" | "pubnet",
  rpcUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UptoGateResult> {
  // Per-network ids first: testnet is where this gets proven, and a mainnet
  // deployment must be a separate, deliberate id rather than an inherited one.
  const perNetwork =
    network === "pubnet" ? env.UPTO_ESCROW_CONTRACT_ID_PUBNET : env.UPTO_ESCROW_CONTRACT_ID_TESTNET;
  const contractId = (perNetwork || env.UPTO_ESCROW_CONTRACT_ID || "").trim();

  if (!contractId) {
    return {
      advertise: false,
      reason: `no upto contract configured for ${network} (set UPTO_ESCROW_CONTRACT_ID_${network.toUpperCase()})`,
    };
  }

  if (!StrKey.isValidContract(contractId)) {
    return {
      advertise: false,
      reason: `configured upto contract id '${contractId}' is not a Stellar contract address (C...)`,
    };
  }

  try {
    const server = new SorobanRpc.Server(rpcUrl);
    const entry = await server.getContractData(
      contractId,
      xdr.ScVal.scvLedgerKeyContractInstance(),
      SorobanRpc.Durability.Persistent,
    );
    if (!entry) {
      return { advertise: false, reason: `no contract is deployed at ${contractId} on ${network}` };
    }
    return { advertise: true, contractId };
  } catch (error: any) {
    return {
      advertise: false,
      reason: `could not confirm a contract is deployed at ${contractId} on ${network}: ${
        error?.message ?? String(error)
      }`,
    };
  }
}

export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
}

/**
 * Asserts `/supported` describes this deployment and not an aspiration.
 *
 * Called at boot with the response the service would actually serve, so a
 * misconfiguration is a failed start rather than a lie told to every client.
 *
 * @param supported - The `/supported` body this service will return
 * @param expectations - What must be true of it
 * @throws {Error} When the advertised capabilities do not match the deployment
 */
export function assertSupportedIsTruthful(
  supported: { kinds: SupportedKind[]; signers?: Record<string, string[]> },
  expectations: {
    network: string;
    feesAreSponsored: boolean;
    uptoContractId?: string;
    signerAddress: string;
  },
): void {
  const exact = supported.kinds.find(
    (kind) => kind.network === expectations.network && kind.scheme === "exact",
  );
  if (!exact) {
    throw new Error(`/supported does not advertise the 'exact' scheme on ${expectations.network}`);
  }

  const sponsored = exact.extra?.areFeesSponsored;
  if (typeof sponsored !== "boolean") {
    throw new Error(
      `/supported entry for ${expectations.network} must carry a boolean 'extra.areFeesSponsored'; got ${JSON.stringify(sponsored)}`,
    );
  }
  if (sponsored !== expectations.feesAreSponsored) {
    throw new Error(
      `/supported advertises areFeesSponsored=${sponsored} but this deployment sponsors fees=${expectations.feesAreSponsored}`,
    );
  }

  const upto = supported.kinds.find(
    (kind) => kind.network === expectations.network && kind.scheme === "upto",
  );
  if (upto && !expectations.uptoContractId) {
    throw new Error(
      "/supported advertises the 'upto' scheme but no deployed upto contract was confirmed on this network",
    );
  }
  if (upto && upto.extra?.contractId !== expectations.uptoContractId) {
    throw new Error(
      `/supported advertises upto contractId=${JSON.stringify(upto.extra?.contractId)} but the confirmed deployment is ${expectations.uptoContractId}`,
    );
  }
  if (!upto && expectations.uptoContractId) {
    throw new Error(
      `an upto contract was confirmed at ${expectations.uptoContractId} but /supported does not advertise the scheme`,
    );
  }

  const signers = supported.signers?.[`${expectations.network.split(":")[0]}:*`] ?? [];
  if (!signers.includes(expectations.signerAddress)) {
    throw new Error(
      `/supported does not list the configured signer ${expectations.signerAddress} among its signers`,
    );
  }
}
