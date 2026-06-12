/**
 * @fileoverview Model-backed underwriting strategy stub.
 *
 * Demonstrates the architectural seam through which a gradient-boosted model
 * (XGBoost/LightGBM) or any ML scorer can be wired into the pipeline without
 * touching the engine, the audit ledger, or the adverse-action disclosure layer.
 *
 * ## Production shape
 *
 * The `externalProbabilityOfDefault` field on {@link FeatureVector} is the
 * integration point. In a live deployment:
 *
 * 1. The {@link FeatureExtractor} assembles the feature vector from telemetry and
 *    online feature-store lookups — same as for rule-based tracks.
 * 2. Before the engine dispatches, a model serving layer (SageMaker real-time
 *    inference, Seldon Core, or BentoML) is called with the feature vector and
 *    returns a probability of default (PD) and — critically — a set of SHAP values.
 * 3. The PD and SHAP payload are attached to the feature vector as
 *    `externalProbabilityOfDefault` (this file uses the PD; a production version
 *    would also receive the SHAP array and translate it into the `factors` list).
 * 4. This strategy maps PD → score and emits a {@link ScoringFactor} per SHAP
 *    contribution, giving the engine identical output to any rule-based track.
 *
 * ## Explainability and adverse-action compliance
 *
 * FCAC (Canada) and equivalent consumer-protection regimes require that any adverse
 * credit decision include the principal reasons it was made. For an ML model this
 * is non-trivial: the score is a non-linear function of hundreds of features, and
 * post-hoc rationalisation from the score alone is not compliant.
 *
 * SHAP (SHapley Additive exPlanations) values solve this directly: each SHAP value
 * is the marginal contribution of one feature to the model's output, in the same
 * units as the output itself, with a mathematical guarantee that contributions sum
 * to the total score. The model serving layer returns one SHAP value per feature;
 * this strategy maps each to a {@link ScoringFactor} with the feature's human-readable
 * label — the same data structure the rule-based tracks produce, giving regulators
 * and applicants factor-level transparency with no black-box exceptions.
 *
 * This stub emits a single placeholder factor. Replace the body of `score()` with
 * a live model call + SHAP mapping and the rest of the pipeline is unchanged.
 */

import type { FeatureVector, ScoreBreakdown, ScoringFactor } from '../types/index.js';
import type { UnderwritingStrategy } from './underwritingStrategy.js';
import { RISK_PARAMETERS } from '../config/riskParameters.js';

const BOUNDS = RISK_PARAMETERS.underwriting.scoreBounds;

/**
 * Conservative fallback PD when no external model score is present.
 *
 * Fail-closed: an absent or unavailable model endpoint must not produce a
 * permissive score. 0.55 maps to a score of ~45 (HIGH tier), which requires
 * manual review rather than auto-approving or auto-declining.
 */
const PD_FALLBACK = 0.55;

/**
 * Underwriting strategy backed by an external probability-of-default model.
 *
 * Registered for `ML_SCORED_POOL` accounts — a hypothetical future segment
 * for which sufficient labelled default data exists to train a supervised model.
 * No telemetry profiles in the current dataset target this pool; the strategy
 * is registered at the composition root to demonstrate that the engine routes
 * to it correctly without modification the moment such profiles arrive.
 *
 * @class ModelBackedUnderwritingStrategy
 */
export class ModelBackedUnderwritingStrategy implements UnderwritingStrategy {
  public readonly trackName = 'ML_MODEL_V1';
  public readonly supportedTenantId = 'ML_SCORED_POOL';

  /**
   * Translates an externally-served probability of default into the pipeline's
   * native {@link ScoreBreakdown} contract.
   *
   * @param features - The feature vector. `externalProbabilityOfDefault` is used
   *   when present; falls back to {@link PD_FALLBACK} when the model serving layer
   *   is unavailable (circuit-breaker open, cold start, etc.).
   * @returns Score breakdown compatible with the tier-classification and
   *   adverse-action disclosure layer.
   */
  public score(features: FeatureVector): ScoreBreakdown {
    const pd = features.externalProbabilityOfDefault ?? PD_FALLBACK;

    // Linear inverse mapping: PD 0.0 → score 100, PD 1.0 → score 0.
    // In production: fit this curve against empirical PD buckets from the model's
    // validation set so that score bands correspond to the same expected default
    // rates across all tracks — enabling consistent tier thresholds portfolio-wide.
    const rawScore = Math.round((1 - pd) * BOUNDS.max);
    const clampedScore = Math.max(BOUNDS.min, Math.min(BOUNDS.max, rawScore));

    // Production version: one ScoringFactor per SHAP value returned by the model
    // serving endpoint, with the feature's human-readable label as `description`.
    // SHAP values sum to the model output by construction, so the factor list is
    // both mathematically grounded and compliant with adverse-action disclosure.
    const pdFactor: ScoringFactor = {
      code: 'ML_PD_SCORE',
      description: `Model probability of default: ${(pd * 100).toFixed(1)}% (SHAP factor breakdown: pending model serving integration)`,
      points: clampedScore - 50,
    };

    return { rawScore, clampedScore, factors: [pdFactor] };
  }
}
