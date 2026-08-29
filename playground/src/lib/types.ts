export interface PlaygroundConfig {
  facilitatorUrl: string;
  demoServerUrl: string;
  bazaarUrl: string;
  network: string;
  horizonUrl: string;
  rpcUrl: string;
  friendbotUrl: string;
  explorerTxUrl: string;
  paidResourceUrl: string;
  paymentAsset: string;
}

export interface ClientWallet {
  publicKey: string;
  secretKey: string;
}

export interface Step {
  id: string;
  title: string;
  note: string;
  state: "pending" | "running" | "ok" | "failed" | "skipped";
  summary?: string;
  error?: string;
  ms?: number;
}

export interface RunRecord {
  startedAt: string;
  completedAt?: string;
  totalMs?: number;
  wallet: ClientWallet;
  initialBalance?: string;
  paymentRequirements?: any;
  paymentPayload?: any;
  verifyResponse?: any;
  settleResponse?: any;
  resourceResponse?: any;
  txHash?: string;
  error?: string;
}
