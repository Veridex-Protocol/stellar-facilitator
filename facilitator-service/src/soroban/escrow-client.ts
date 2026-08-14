/**
 * Veridex Facilitator Service - Soroban Escrow Client
 * License: Apache-2.0
 *
 * TypeScript client for upto_escrow Soroban contract.
 */

import {
  Contract,
  rpc as SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Keypair,
  Address,
  xdr,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";

/**
 * Escrow account details
 */
export interface EscrowAccount {
  client: string;
  resourceServer: string;
  balance: bigint;
  consumed: bigint;
  requestCount: number;
  lastActivity: bigint;
}

/**
 * Settlement record
 */
export interface SettlementRecord {
  requestId: string;
  amount: bigint;
  timestamp: bigint;
  resourceId: string;
}

/**
 * Soroban Escrow Client configuration
 */
export interface EscrowClientConfig {
  /** Contract ID */
  contractId: string;

  /** RPC server URL */
  rpcUrl: string;

  /** Network passphrase */
  networkPassphrase: string;

  /** Source keypair for signing */
  sourceKeypair: Keypair;
}

/**
 * Soroban Escrow Client
 *
 * Interact with upto_escrow contract for metered billing.
 */
export class SorobanEscrowClient {
  private config: EscrowClientConfig;
  private contract: Contract;
  private server: SorobanRpc.Server;

  constructor(config: EscrowClientConfig) {
    this.config = config;
    this.contract = new Contract(config.contractId);
    this.server = new SorobanRpc.Server(config.rpcUrl);
  }

  /**
   * Deposit XLM into escrow
   *
   * @param clientAddress - Client address
   * @param resourceServerAddress - Resource server address
   * @param amountStroops - Amount in stroops
   * @returns Escrow account
   */
  async deposit(
    clientAddress: string,
    resourceServerAddress: string,
    amountStroops: bigint
  ): Promise<EscrowAccount> {
    const account = await this.server.getAccount(this.config.sourceKeypair.publicKey());

    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "deposit",
          Address.fromString(clientAddress).toScVal(),
          Address.fromString(resourceServerAddress).toScVal(),
          nativeToScVal(amountStroops, { type: "i128" })
        )
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(transaction);
    prepared.sign(this.config.sourceKeypair);

    const result = await this.server.sendTransaction(prepared);

    if (result.status === "ERROR") {
      throw new Error(`Transaction failed: ${result.errorResult?.toXDR("base64")}`);
    }

    const txResult = await this.pollTransaction(result.hash);
    const successResult = txResult as SorobanRpc.Api.GetSuccessfulTransactionResponse;

    if (!successResult.returnValue) {
      throw new Error("No return value from deposit");
    }

    return this.parseEscrowAccount(successResult.returnValue);
  }

  /**
   * Settle a request
   *
   * @param clientAddress - Client address
   * @param resourceServerAddress - Resource server address
   * @param requestId - Unique request ID
   * @param amountStroops - Amount to charge
   * @param resourceId - Resource identifier
   * @returns Settlement record
   */
  async settle(
    clientAddress: string,
    resourceServerAddress: string,
    requestId: string,
    amountStroops: bigint,
    resourceId: string
  ): Promise<SettlementRecord> {
    const account = await this.server.getAccount(this.config.sourceKeypair.publicKey());

    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "settle",
          Address.fromString(clientAddress).toScVal(),
          Address.fromString(resourceServerAddress).toScVal(),
          nativeToScVal(requestId, { type: "symbol" }),
          nativeToScVal(amountStroops, { type: "i128" }),
          nativeToScVal(resourceId, { type: "symbol" })
        )
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(transaction);
    prepared.sign(this.config.sourceKeypair);

    const result = await this.server.sendTransaction(prepared);

    if (result.status === "ERROR") {
      throw new Error(`Transaction failed: ${result.errorResult?.toXDR("base64")}`);
    }

    const txResult = await this.pollTransaction(result.hash);
    const successResult = txResult as SorobanRpc.Api.GetSuccessfulTransactionResponse;

    if (!successResult.returnValue) {
      throw new Error("No return value from settle");
    }

    return this.parseSettlementRecord(successResult.returnValue);
  }

  /**
   * Claim accumulated charges
   *
   * @param resourceServerAddress - Resource server address
   * @param clientAddress - Client address
   * @returns Amount claimed (stroops)
   */
  async claim(resourceServerAddress: string, clientAddress: string): Promise<bigint> {
    const account = await this.server.getAccount(this.config.sourceKeypair.publicKey());

    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "claim",
          Address.fromString(resourceServerAddress).toScVal(),
          Address.fromString(clientAddress).toScVal()
        )
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(transaction);
    prepared.sign(this.config.sourceKeypair);

    const result = await this.server.sendTransaction(prepared);

    if (result.status === "ERROR") {
      throw new Error(`Transaction failed: ${result.errorResult?.toXDR("base64")}`);
    }

    const txResult = await this.pollTransaction(result.hash);
    const successResult = txResult as SorobanRpc.Api.GetSuccessfulTransactionResponse;

    if (!successResult.returnValue) {
      throw new Error("No return value from claim");
    }

    return scValToNative(successResult.returnValue);
  }

  /**
   * Withdraw unused balance
   *
   * @param clientAddress - Client address
   * @param resourceServerAddress - Resource server address
   * @returns Amount withdrawn (stroops)
   */
  async withdraw(clientAddress: string, resourceServerAddress: string): Promise<bigint> {
    const account = await this.server.getAccount(this.config.sourceKeypair.publicKey());

    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "withdraw",
          Address.fromString(clientAddress).toScVal(),
          Address.fromString(resourceServerAddress).toScVal()
        )
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(transaction);
    prepared.sign(this.config.sourceKeypair);

    const result = await this.server.sendTransaction(prepared);

    if (result.status === "ERROR") {
      throw new Error(`Transaction failed: ${result.errorResult?.toXDR("base64")}`);
    }

    const txResult = await this.pollTransaction(result.hash);
    const successResult = txResult as SorobanRpc.Api.GetSuccessfulTransactionResponse;

    if (!successResult.returnValue) {
      throw new Error("No return value from withdraw");
    }

    return scValToNative(successResult.returnValue);
  }

  /**
   * Get escrow account (read-only)
   *
   * @param clientAddress - Client address
   * @param resourceServerAddress - Resource server address
   * @returns Escrow account or null
   */
  async getEscrow(
    clientAddress: string,
    resourceServerAddress: string
  ): Promise<EscrowAccount | null> {
    const account = await this.server.getAccount(this.config.sourceKeypair.publicKey());

    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "get_escrow",
          Address.fromString(clientAddress).toScVal(),
          Address.fromString(resourceServerAddress).toScVal()
        )
      )
      .setTimeout(30)
      .build();

    const simulated = await this.server.simulateTransaction(transaction);

    if (
      SorobanRpc.Api.isSimulationSuccess(simulated) &&
      simulated.result?.retval
    ) {
      const result = simulated.result.retval;

      // Check for Option::None
      if (result.switch().name === "scvVoid") {
        return null;
      }

      return this.parseEscrowAccount(result);
    }

    return null;
  }

  /**
   * Get settlement record (read-only)
   *
   * @param clientAddress - Client address
   * @param resourceServerAddress - Resource server address
   * @param requestId - Request ID
   * @returns Settlement record or null
   */
  async getSettlement(
    clientAddress: string,
    resourceServerAddress: string,
    requestId: string
  ): Promise<SettlementRecord | null> {
    const account = await this.server.getAccount(this.config.sourceKeypair.publicKey());

    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "get_settlement",
          Address.fromString(clientAddress).toScVal(),
          Address.fromString(resourceServerAddress).toScVal(),
          nativeToScVal(requestId, { type: "symbol" })
        )
      )
      .setTimeout(30)
      .build();

    const simulated = await this.server.simulateTransaction(transaction);

    if (
      SorobanRpc.Api.isSimulationSuccess(simulated) &&
      simulated.result?.retval
    ) {
      const result = simulated.result.retval;

      if (result.switch().name === "scvVoid") {
        return null;
      }

      return this.parseSettlementRecord(result);
    }

    return null;
  }

  /**
   * Poll transaction status
   */
  private async pollTransaction(
    hash: string,
    maxAttempts: number = 20
  ): Promise<SorobanRpc.Api.GetTransactionResponse> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const tx = await this.server.getTransaction(hash);

      if (tx.status === "SUCCESS") {
        return tx;
      }

      if (tx.status === "FAILED") {
        throw new Error(`Transaction failed: ${tx.resultXdr?.toXDR("base64")}`);
      }
    }

    throw new Error("Transaction polling timeout");
  }

  /**
   * Parse EscrowAccount from ScVal
   */
  private parseEscrowAccount(scVal: xdr.ScVal): EscrowAccount {
    const native = scValToNative(scVal);

    return {
      client: native.client,
      resourceServer: native.resource_server,
      balance: BigInt(native.balance),
      consumed: BigInt(native.consumed),
      requestCount: Number(native.request_count),
      lastActivity: BigInt(native.last_activity),
    };
  }

  /**
   * Parse SettlementRecord from ScVal
   */
  private parseSettlementRecord(scVal: xdr.ScVal): SettlementRecord {
    const native = scValToNative(scVal);

    return {
      requestId: native.request_id,
      amount: BigInt(native.amount),
      timestamp: BigInt(native.timestamp),
      resourceId: native.resource_id,
    };
  }
}

/**
 * Create Soroban escrow client
 */
export function createEscrowClient(config: EscrowClientConfig): SorobanEscrowClient {
  return new SorobanEscrowClient(config);
}
