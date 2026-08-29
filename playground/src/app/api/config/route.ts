import { NextResponse } from "next/server";

function trimUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export async function GET() {
  const network = process.env.STELLAR_NETWORK || "testnet";

  if (network !== "testnet") {
    return NextResponse.json(
      { error: "Playground is only supported on testnet." },
      { status: 400 }
    );
  }

  const config = {
    facilitatorUrl: trimUrl(process.env.FACILITATOR_URL || "http://localhost:3002"),
    demoServerUrl: trimUrl(process.env.DEMO_SERVER_URL || "http://localhost:3003"),
    bazaarUrl: trimUrl(process.env.BAZAAR_URL || "http://localhost:3001"),
    network: `stellar:${network}`,
    horizonUrl: trimUrl(process.env.HORIZON_URL || "https://horizon-testnet.stellar.org"),
    rpcUrl: trimUrl(process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org"),
    friendbotUrl: trimUrl(process.env.FRIENDBOT_URL || "https://friendbot.stellar.org"),
    explorerTxUrl: trimUrl(
      process.env.EXPLORER_TX_URL || "https://stellar.expert/explorer/testnet/tx"
    ),
    paidResourcePath: process.env.PAID_RESOURCE_PATH || "/paid-resource",
    paymentAsset:
      process.env.PAYMENT_ASSET || "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  };

  return NextResponse.json({
    ...config,
    paidResourceUrl: `${config.demoServerUrl}${config.paidResourcePath}`,
  });
}
