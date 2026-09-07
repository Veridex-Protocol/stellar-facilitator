import type { GatewayEventStore, ProviderOutcomeRecord, VeridexPaymentEvent } from "./types.js";

export class InMemoryGatewayEventStore implements GatewayEventStore {
  readonly paymentEvents: VeridexPaymentEvent[] = [];
  readonly providerOutcomes: ProviderOutcomeRecord[] = [];

  async appendPaymentEvent(event: VeridexPaymentEvent): Promise<void> {
    this.paymentEvents.push(structuredClone(event));
  }

  async appendProviderOutcome(outcome: ProviderOutcomeRecord): Promise<void> {
    this.providerOutcomes.push(structuredClone(outcome));
  }

  async findSettlement(paymentId: string): Promise<VeridexPaymentEvent | undefined> {
    return this.paymentEvents.find(
      (event) => event.paymentId === paymentId && event.status === "settled",
    );
  }
}