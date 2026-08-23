/**
 * The visitor's wallet.
 * License: Apache-2.0
 *
 * Generated here, in the browser, and never sent anywhere. The playground
 * server has no key material and no funds; there is nothing for it to custody.
 * The secret lives in `sessionStorage`, which means it survives a reload and
 * dies with the tab.
 *
 * This is a testnet-only convenience. It is not a wallet, it should never hold
 * anything of value, and the UI says so.
 */

import { Keypair, rpc as SorobanRpc } from "@stellar/stellar-sdk";
import type { PlaygroundConfig } from "./config.js";

const STORAGE_KEY = "veridex.playground.secret";

export interface Wallet {
  secret: string;
  address: string;
}

/**
 * Reads the wallet from this tab, if one was already created.
 *
 * Storage access throws outright in some privacy configurations, so every read
 * is guarded rather than assumed to work.
 *
 * @returns The existing wallet, or undefined
 */
export function existingWallet(): Wallet | undefined {
  try {
    const secret = sessionStorage.getItem(STORAGE_KEY);
    if (!secret) return undefined;
    return { secret, address: Keypair.fromSecret(secret).publicKey() };
  } catch {
    return undefined;
  }
}

/**
 * Creates a new keypair for this tab.
 *
 * @returns The new wallet
 */
export function createWallet(): Wallet {
  const keypair = Keypair.random();
  const wallet = { secret: keypair.secret(), address: keypair.publicKey() };
  try {
    sessionStorage.setItem(STORAGE_KEY, wallet.secret);
  } catch {
    // A tab that cannot persist still works; it just starts fresh on reload.
  }
  return wallet;
}

/**
 * Forgets this tab's wallet.
 */
export function forgetWallet(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do: if it cannot be written it was never stored.
  }
}

/**
 * Asks Friendbot to create and fund the account.
 *
 * Friendbot answers 400 for an account that already exists, which is a
 * success from here: the point is a funded account, not a fresh one.
 *
 * @param config - Playground configuration
 * @param address - The account to fund
 * @throws {Error} When Friendbot neither funds nor recognises the account
 */
export async function fundFromFriendbot(
  config: PlaygroundConfig,
  address: string,
): Promise<void> {
  const response = await fetch(`${config.friendbotUrl}/?addr=${encodeURIComponent(address)}`);
  if (response.ok) return;

  if (response.status === 400) {
    const body = await response.text();
    if (/exists|op_already_exists/i.test(body)) return;
    throw new Error(`Friendbot refused to fund the account: ${body.slice(0, 160)}`);
  }
  throw new Error(`Friendbot returned HTTP ${response.status}`);
}

/**
 * Waits until the account is consistently visible from Soroban RPC.
 *
 * Horizon confirming the Friendbot payment is not enough. Payments simulate
 * against Soroban RPC, which lags Horizon and is load-balanced across nodes at
 * different ledger heights. Paying too early fails with "account entry is
 * missing" - the account exists, that node just has not seen it yet.
 *
 * Requiring several consecutive successful reads makes it likely every node
 * behind the balancer has caught up. This mirrors `waitForRpcVisibility` in
 * scripts/bootstrap-testnet.mjs, and skipping it is what makes a first payment
 * fail for no reason a visitor could understand.
 *
 * @param config - Playground configuration
 * @param address - The account to wait for
 * @param onAttempt - Called with the current consecutive-read streak
 * @throws {Error} When the account never becomes consistently visible
 */
export async function waitForRpcVisibility(
  config: PlaygroundConfig,
  address: string,
  onAttempt?: (streak: number, required: number) => void,
): Promise<void> {
  const server = new SorobanRpc.Server(config.rpcUrl);
  const required = 3;
  const deadline = Date.now() + 90_000;
  let streak = 0;
  let lastError = "not visible";

  while (Date.now() < deadline) {
    try {
      await server.getAccount(address);
      streak += 1;
      onAttempt?.(streak, required);
      if (streak >= required) return;
    } catch (error) {
      streak = 0;
      onAttempt?.(streak, required);
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  throw new Error(
    `${address} was funded, but Soroban RPC has still not caught up (${lastError}). ` +
      "Testnet RPC is lagging; wait a moment and try again.",
  );
}

/**
 * Reads the account's native XLM balance from Horizon.
 *
 * @param config - Playground configuration
 * @param address - The account to read
 * @returns The balance as a decimal string, or undefined when the account does not exist
 */
export async function nativeBalance(
  config: PlaygroundConfig,
  address: string,
): Promise<string | undefined> {
  const response = await fetch(`${config.horizonUrl}/accounts/${address}`);
  if (!response.ok) return undefined;
  const account = (await response.json()) as {
    balances?: Array<{ asset_type: string; balance: string }>;
  };
  return account.balances?.find((balance) => balance.asset_type === "native")?.balance;
}
