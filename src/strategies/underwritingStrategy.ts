/**
 * @fileoverview The underwriting strategy contract (Strategy pattern).
 *
 * Each tenant pool carries fundamentally different credit economics, so a single
 * scoring function cannot serve all of them without mislabeling risk. This
 * interface defines the seam through which the orchestrating engine dispatches a
 * telemetry event to the strategy appropriate for its pool — alternative-data
 * scoring for thin-file migrants, traditional scoring for collateral-backed
 * secured accounts — while remaining agnostic to the concrete implementation.
 *
 * New pools (e.g., a future BNPL or co-brand portfolio) are onboarded by adding a
 * strategy that satisfies this contract, with zero changes to the engine.
 */

import type { FeatureVector, ScoreBreakdown } from '../types/index.js';

/**
 * A self-describing, deterministic underwriting model for a single tenant pool.
 *
 * Implementations must be pure with respect to the input feature vector: identical
 * input yields identical output, with no side effects. This guarantees
 * reproducibility for audit, back-testing, and model-governance review.
 *
 * Accepting a {@link FeatureVector} rather than raw {@link CreditTelemetry} is the
 * central interface invariant: strategies consume pre-computed, validated features,
 * not raw events. This enforces the training/serving parity guarantee — the same
 * FeatureExtractor that produces features for this call produced features for the
 * training dataset, so no feature can be computed differently between the two paths.
 *
 * @interface UnderwritingStrategy
 */
export interface UnderwritingStrategy {
  /** Stable identifier of this scoring track (e.g., 'ALTERNATIVE_DATA_V1'). */
  readonly trackName: string;
  /** The tenant pool identifier this strategy is calibrated to serve. */
  readonly supportedTenantId: string;
  /**
   * Scores a pre-computed feature vector, returning a fully transparent breakdown.
   *
   * @param features - The model-ready feature vector for the account event.
   * @returns The raw and clamped scores plus the complete factor list.
   */
  score(features: FeatureVector): ScoreBreakdown;
}
