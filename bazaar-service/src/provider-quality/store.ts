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
  source: "in_band" | "independent";
  disagreementRecorded?: boolean;
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
         signer, signature, observation_source, outcome
       ) VALUES ($1, $2, $3, $4, to_timestamp($5), $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb)
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
        input.source ?? "in_band",
        JSON.stringify(observation),
      ],
    );
    const record = mapObservation(result.rows[0]);
    const disagreementRecorded = await this.recordDisagreements(record);
    return { ...record, disagreementRecorded };
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
       WHERE signer = $1 AND signature = $2
         AND (settlement_tx IS NULL OR settlement_tx = $3)`,
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
              faults_observed, observation_count, aggregation_window, retrieved_at,
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
      window: row.aggregation_window,
      retrievedAt: Math.floor(new Date(row.retrieved_at).getTime() / 1000),
      issuer: row.issuer,
      signature: row.signature,
    };
  }

  async saveAggregate(aggregate: ProviderAggregate): Promise<void> {
    await this.db.query(
      `INSERT INTO provider_quality_aggregates (
         endpoint, pay_to, state, fault_rate_upper_bound, faults_observed,
         observation_count, aggregation_window, retrieved_at, issuer, signature, aggregate
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

  private async recordDisagreements(record: ProviderObservationRecord): Promise<boolean> {
    const opposite = record.source === "in_band" ? "independent" : "in_band";
    const result = await this.db.query<ProviderObservationRow>(
      `SELECT * FROM provider_observations
       WHERE resource = $1 AND pay_to = $2 AND request_digest = $3
         AND observation_source = $4
       ORDER BY observed_at DESC LIMIT 1`,
      [record.resource, record.payTo, record.requestDigest, opposite],
    );
    const otherRow = result.rows[0];
    if (!otherRow) return false;
    const other = mapObservation(otherRow);
    const fields = [
      record.responseDigest !== other.responseDigest ? "responseDigest" : undefined,
      record.usable !== other.usable ? "usable" : undefined,
      record.providerAtFault !== other.providerAtFault ? "providerAtFault" : undefined,
      record.attributable !== other.attributable ? "attributable" : undefined,
      record.reasonCode !== other.reasonCode ? "reasonCode" : undefined,
      record.usageAtomic !== other.usageAtomic ? "usageAtomic" : undefined,
    ].filter((field): field is string => Boolean(field));
    if (fields.length === 0) return false;
    const inBand = record.source === "in_band" ? record : other;
    const independent = record.source === "independent" ? record : other;
    await this.db.query(
      `INSERT INTO provider_observation_disagreements (
         resource, pay_to, request_digest, in_band_observation_id,
         independent_observation_id, fields
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (in_band_observation_id, independent_observation_id) DO NOTHING`,
      [record.resource, record.payTo, record.requestDigest, inBand.id, independent.id, fields],
    );
    return true;
  }

  async listDisagreements(resource: string, payTo?: string, limit = 100): Promise<QueryResultRow[]> {
    const result = await this.db.query(
      `SELECT resource, pay_to, request_digest, in_band_observation_id,
              independent_observation_id, fields, created_at
       FROM provider_observation_disagreements
       WHERE resource = $1 AND ($2::text IS NULL OR pay_to = $2)
       ORDER BY created_at DESC LIMIT $3`,
      [resource, payTo ?? null, Math.min(500, Math.max(1, limit))],
    );
    return result.rows;
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
  observation_source: "in_band" | "independent";
  created_at: Date;
}

interface ProviderAggregateRow extends QueryResultRow {
  endpoint: string;
  pay_to: string | null;
  state: "insufficient_data" | "provisional" | "published";
  fault_rate_upper_bound: number;
  faults_observed: number;
  observation_count: number;
  aggregation_window: string;
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
    source: row.observation_source,
    createdAt: row.created_at,
  };
}