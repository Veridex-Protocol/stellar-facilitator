import { createFacilitatorClient } from "../src/facilitator-client";
import { Keypair } from "@stellar/stellar-sdk";

async function run() {
  const facilitatorUrl = process.env.FACILITATOR_URL || "http://localhost:3002";
  const clientSecret = process.env.CLIENT_SECRET;
  if (!clientSecret) {
    console.error("CLIENT_SECRET must be set (funded testnet account)");
    process.exit(1);
  }

  const client = createFacilitatorClient({ facilitatorUrl, network: "testnet", clientSecretKey: clientSecret });

  for (let i = 0; i < 10; i++) {
    const req = {
      resourceUrl: `https://example.com/resource/${i}`,
      amountStroops: "100000",
      toolName: "e2e-runner",
      sessionId: `${Date.now()}-${i}`,
    };

    try {
      const res = await client.pay(req as any);
      console.log(i, res);
    } catch (err) {
      console.error("payment error", err);
    }
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
