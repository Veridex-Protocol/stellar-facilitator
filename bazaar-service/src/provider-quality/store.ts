/**
 * Provider-quality observation store.
 * License: Apache-2.0
 */

import type { QueryResultRow } from "pg";
import { Database } from "../db/config.js";
import { ProviderObservationSchema, type ProviderAggregate, type ProviderObservation, type ProviderObservationWrite } from "./types.js";

export interface ProviderObservationRecord {
  id: string;
  resource: string;
  payTo: string;
  requestDigest: string;
  responseDigest: string;
  observedAt: Date;
  usable: boolean;
  providerAtFault: boolean;
  attributable: "provider" | "caller" | "unknown";
  reasonCode: string;
  usageAtomic?: string;
  responseStatus?: number;
  toolName?: string;
  route?: string;
  callId?: string;
  settlementTx?: string;
  signer: string;
  signature: string;
  createdAt: Date;
}

export class ProviderQualityStore {
  constructor(private readonly db: Database) {}

  async recordObservation(input: ProviderObservationWrite): Promise<ProviderObservationRecord> {
    const observation = ProviderObservationSchema.parse({
      ...input.observation,
      toolName: input.toolName ?? input.observation.toolName,
      route: input.route ?? input.observation.route,
      callId: input.callId ?? input.observation.callId,
      settlementTx: input.settlementTx ?? input.observation.settlementTx,
    });
    const result = await this.db.query<ProviderObservationRow>(
      `INSERT INTO provider_observations (
         resource, pay_to, request_digest, response_digest, observed_at,
         usable, provider_at_fault, attributable, reason_code, usage_atomic,
         response_status, tool_name, route, call_id, settlement_tx,
         signer, signature, outcome
       ) VALUES ($1, $2, $3, $4, to_timestamp($5), $6, $7, $8, $9, $10,
                 $11, $12, $13, $14, $15, $16, $17, $18::jsonb)
       ON CONFLICT (signer, signature) DO UPDATE SET
         settlement_tx = COALESCE(EXCLUDED.settlement_tx, provider_observations.settlement_tx)
       RETURNING *`,
      [
        observation.resource,
        observation.payTo,
        observation.requestDigest,
        observation.responseDigest,
        observation.observedAt,
        observation.usable,
        observation.providerAtFault,
        observation.attributable,
        observation.reasonCode,
        observation.usageAtomic ?? null,
        observation.responseStatus ?? null,
        observation.toolName ?? null,
        observation.route ?? null,
        observation.callId ?? null,
        observation.settlementTx ?? null,
        observation.signer,
        observation.signature,
        JSON.stringify(observation),
      ],
    );
    return mapObservation(result.rows[0]);
  }

  async listObservations(resource: string, payTo?: string, limit = 100): Promise<ProviderObservationRecord[]> {
    const result = await this.db.query<ProviderObservationRow>(
      `SELECT * FROM provider_observations
       WHERE resource = $1 AND ($2::text IS NULL OR pay_to = $2)
       ORDER BY observed_at DESC LIMIT $3`,
      [resource, payTo ?? null, Math.min(500, Math.max(1, limit))],
    );
    return result.rows.map(mapObservation);
  }

  async attachSettlement(
    signer: string,
    signature: string,
    settlementTx: string,
  ): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE provider_observations
       SET settlement_tx = COALESCE(settlement_tx, $3)
       WHERE signer = $1 AND signature = $2`,
      [signer, signature, settlementTx],
    );
    return result.rowCount === 1;
  }

  async listObservationsForAggregate(
    resource: string,
    payTo?: string,
    windowSeconds = 30 * 24 * 60 * 60,
    nowSeconds = Math.floor(Date.now() / 1000),
  ): Promise<ProviderObservationRecord[]> {
    const result = await this.db.query<ProviderObservationRow>(
      `SELECT * FROM provider_observations
       WHERE resource = $1
         AND ($2::text IS NULL OR pay_to = $2)
         AND observed_at >= to_timestamp($3)
         AND observed_at <= to_timestamp($4)
       ORDER BY observed_at DESC`,
      [resource, payTo ?? null, nowSeconds - windowSeconds, nowSeconds],
    );
    return result.rows.map(mapObservation);
  }

  async getAggregate(resource: string, payTo?: string): Promise<ProviderAggregate | null> {
    const result = await this.db.query<ProviderAggregateRow>(
      `SELECT endpoint, pay_to, state, fault_rate_upper_bound,
              faults_observed, observation_count, window, retrieved_at,
              issuer, signature
       FROM provider_quality_aggregates
       WHERE endpoint = $1 AND ($2::text IS NULL OR pay_to = $2)
       ORDER BY retrieved_at DESC LIMIT 1`,
      [resource, payTo ?? null],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      v: "veridex/provider-aggregate/1",
      endpoint: row.endpoint,
      ...(row.pay_to ? { payTo: row.pay_to } : {}),
      state: row.state,
      faultRateUpperBound: Number(row.fault_rate_upper_bound),
      faultsObserved: Number(row.faults_observed),
      n: Number(row.observation_count),
      window: row.window,
      retrievedAt: Math.floor(new Date(row.retrieved_at).getTime() / 1000),
      issuer: row.issuer,
      signature: row.signature,
    };
  }

  async saveAggregate(aggregate: ProviderAggregate): Promise<void> {
    await this.db.query(
      `INSERT INTO provider_quality_aggregates (
         endpoint, pay_to, state, fault_rate_upper_bound, faults_observed,
         observation_count, window, retrieved_at, issuer, signature, aggregate
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8), $9, $10, $11::jsonb)
      ON CONFLICT DO NOTHING`,
      [
        aggregate.endpoint,
        aggregate.payTo ?? "",
        aggregate.state,
        aggregate.faultRateUpperBound,
        aggregate.faultsObserved,
        aggregate.n,
        aggregate.window,
        aggregate.retrievedAt,
        aggregate.issuer,
        aggregate.signature,
        JSON.stringify(aggregate),
      ],
    );
  }
}

interface ProviderObservationRow extends QueryResultRow {
  id: string;
  resource: string;
  pay_to: string;
  request_digest: string;
  response_digest: string;
  observed_at: Date;
  usable: boolean;
  provider_at_fault: boolean;
  attributable: "provider" | "caller" | "unknown";
  reason_code: string;
  usage_atomic: string | null;
  response_status: number | null;
  tool_name: string | null;
  route: string | null;
  call_id: string | null;
  settlement_tx: string | null;
  signer: string;
  signature: string;
  created_at: Date;
}

interface ProviderAggregateRow extends QueryResultRow {
  endpoint: string;
  pay_to: string | null;
  state: "insufficient_data" | "provisional" | "published";
  fault_rate_upper_bound: number;
  faults_observed: number;
  observation_count: number;
  window: string;
  retrieved_at: Date;
  issuer: string;
  signature: string;
}

function mapObservation(row: ProviderObservationRow): ProviderObservationRecord {
  return {
    id: row.id,
    resource: row.resource,
    payTo: row.pay_to,
    requestDigest: row.request_digest,
    responseDigest: row.response_digest,
    observedAt: row.observed_at,
    usable: row.usable,
    providerAtFault: row.provider_at_fault,
    attributable: row.attributable,
    reasonCode: row.reason_code,
    ...(row.usage_atomic !== null ? { usageAtomic: row.usage_atomic } : {}),
    ...(row.response_status !== null ? { responseStatus: row.response_status } : {}),
    ...(row.tool_name !== null ? { toolName: row.tool_name } : {}),
    ...(row.route !== null ? { route: row.route } : {}),
    ...(row.call_id !== null ? { callId: row.call_id } : {}),
    ...(row.settlement_tx !== null ? { settlementTx: row.settlement_tx } : {}),
    signer: row.signer,
    signature: row.signature,
    createdAt: row.created_at,
  };
}