/**
 * @fileoverview Feature extraction layer for the Neo Risk Underwriting Pipeline.
 *
 * The FeatureExtractor is the single boundary between raw transaction telemetry
 * and the model-ready {@link FeatureVector} consumed by every underwriting strategy.
 * Centralising feature computation here enforces the most important invariant in
 * a production ML credit pipeline: **training/serving parity**.
 *
 * If features are computed in two different places — once in the training pipeline
 * and once at serving time — subtle discrepancies accumulate silently. The model
 * scores inputs it was never trained on, degrading approval/decline accuracy in
 * ways that don't surface in offline evaluation metrics. The extractor eliminates
 * this risk by being the authoritative, single-source implementation for every
 * derived feature.
 *
 * In production, this extractor bridges two types of features:
 *
 * **Online features** — retrieved per-request from a low-latency feature store
 * (Redis, DynamoDB, or a managed platform such as Feast or Tecton). These are
 * pre-computed by streaming jobs (e.g., a Flink/Kafka pipeline) and stored keyed
 * by account ID, so each request gets consistent, fresh values without recomputing
 * from scratch. The trailing 90-day spend average and rent-payment streak are
 * examples: expensive to compute at request time, but cheap to look up.
 *
 * **Request-time features** — derived from the incoming event itself and computed
 * here (e.g., `spendVelocityMultiple`, `isQuasiCashMerchant`). These must be
 * implemented identically in the offline feature-generation pipeline used at
 * training time, which is why this class — not an ad-hoc inline expression — is
 * the canonical definition.
 *
 * The extractor is stateless and deterministic: identical input always yields
 * identical output, making it safe to deploy in a distributed, horizontally-scaled
 * scoring service with no coordination between instances.
 */

import type { CreditTelemetry, FeatureVector } from '../types/index.js';

/** MCCs that indicate quasi-cash or cash-equivalent transactions. */
const QUASI_CASH_MCCS = new Set([
  6011, // ATM cash advance
  6051, // Quasi-cash / cryptocurrency purchases
]);

/**
 * Computes the model-ready {@link FeatureVector} from raw telemetry.
 *
 * In production this class would additionally fetch online features from the
 * feature store before returning the assembled vector. The store call is omitted
 * here; the `historicalMetrics` embedded in the telemetry event stand in for what
 * would be a real-time lookup against pre-aggregated account state.
 *
 * @class FeatureExtractor
 */
export class FeatureExtractor {
  /**
   * Extracts and derives all features required for underwriting decisioning.
   *
   * @param telemetry - The raw transaction telemetry event.
   * @returns The {@link FeatureVector} ready for consumption by any registered
   *   {@link UnderwritingStrategy}.
   */
  public extract(telemetry: CreditTelemetry): FeatureVector {
    const { amount, merchantCategoryCode, historicalMetrics } = telemetry;
    const { averageDailySpend, consecutiveRentPayments, cashReserveRatio } = historicalMetrics;

    // Guard against divide-by-zero on brand-new accounts with no spend history.
    // Positive infinity is intentional: a transaction on a zero-baseline account
    // is infinitely anomalous, which is correct — it should trigger the velocity rule.
    const spendVelocityMultiple =
      averageDailySpend > 0 ? amount / averageDailySpend : Number.POSITIVE_INFINITY;

    return {
      tenantId: telemetry.tenantId,
      accountId: telemetry.accountId,
      transactionAmountCents: amount,
      merchantCategoryCode,
      consecutiveRentMonths: consecutiveRentPayments,
      cashReserveRatio,
      averageDailySpendCents: averageDailySpend,
      spendVelocityMultiple,
      isQuasiCashMerchant: QUASI_CASH_MCCS.has(merchantCategoryCode),
    };
  }
}
