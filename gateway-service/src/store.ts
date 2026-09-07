import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
    return this.paymentEvents.findLast(
      (event) => event.paymentId === paymentId && event.status === "settled",
    );
  }

  async listPaymentEvents(gatewayId: string): Promise<VeridexPaymentEvent[]> {
    return this.paymentEvents
      .filter((event) => event.gatewayId === gatewayId)
      .map((event) => structuredClone(event));
  }

  async listProviderOutcomes(gatewayId: string): Promise<ProviderOutcomeRecord[]> {
    return this.providerOutcomes
      .filter((outcome) => outcome.gatewayId === gatewayId)
      .map((outcome) => structuredClone(outcome));
  }
}

export class JsonlGatewayEventStore implements GatewayEventStore {
  private readonly paymentsPath: string;
  private readonly outcomesPath: string;
  private writeQueue = Promise.resolve();

  constructor(directory = ".veridex/gateway") {
    this.paymentsPath = join(directory, "payment-events.jsonl");
    this.outcomesPath = join(directory, "provider-outcomes.jsonl");
  }

  appendPaymentEvent(event: VeridexPaymentEvent): Promise<void> {
    return this.append(this.paymentsPath, event);
  }

  appendProviderOutcome(outcome: ProviderOutcomeRecord): Promise<void> {
    return this.append(this.outcomesPath, outcome);
  }

  async findSettlement(paymentId: string): Promise<VeridexPaymentEvent | undefined> {
    const events = await this.readLines<VeridexPaymentEvent>(this.paymentsPath);
    return events.findLast((event) => event.paymentId === paymentId && event.status === "settled");
  }

  async listPaymentEvents(gatewayId: string): Promise<VeridexPaymentEvent[]> {
    return (await this.readLines<VeridexPaymentEvent>(this.paymentsPath))
      .filter((event) => event.gatewayId === gatewayId);
  }

  async listProviderOutcomes(gatewayId: string): Promise<ProviderOutcomeRecord[]> {
    return (await this.readLines<ProviderOutcomeRecord>(this.outcomesPath))
      .filter((outcome) => outcome.gatewayId === gatewayId);
  }

  private append(path: string, value: unknown): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await appendFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    });
    return this.writeQueue;
  }

  private async readLines<T>(path: string): Promise<T[]> {
    try {
      const contents = await readFile(path, "utf8");
      return contents.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}