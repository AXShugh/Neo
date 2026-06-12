/**
 * @fileoverview Core domain types for the Neo Risk Underwriting Pipeline.
 *
 * Defines the explicit, un-nested contracts shared across every layer of the
 * pipeline: ingestion, underwriting strategy, anomaly detection, audit, and
 * observability. Every consumer of these types programs against the interface,
 * never a concrete implementation — enabling independent evolution of each layer
 * (e.g., swapping an underwriting strategy without touching the orchestrator).
 *
 * Monetary convention: all amounts are integer USD cents. Floating-point dollars
 * are produced only at the presentation boundary to eliminate accumulation drift,
 * a non-negotiable property for systems feeding asset-backed securitization (ABS)
 * accounting and waterfall calculations.
 *
 * @see https://www.sifma.org/documents/ABS%20primers/Primer_ABS_20210318.pdf
 */

/**
 * Categorical risk classification emitted by the underwriting layer.
 *
 * Tiers map directly to downstream pricing, loss-reserve provisioning, and ABS
 * pool segmentation buckets:
 * - `LOW`     — prime; eligible for senior tranche allocation
 * - `MEDIUM`  — near-prime; mezzanine eligibility, manual review recommended
 * - `HIGH`    — subprime; conditional approval, elevated reserve requirement
 * - `DECLINE` — fails minimum credit-quality threshold for any pool
 */
export type RiskTier = 'LOW' | 'MEDIUM' | 'HIGH' | 'DECLINE';

/**
 * Severity classification emitted by the securitization guard (anomaly) layer.
 *
 * - `HIGH`     — compliance violation requiring investigation before settlement
 * - `CRITICAL` — active fraud signature requiring immediate asset-pool protection
 */
export type AnomalyRiskLevel = 'HIGH' | 'CRITICAL';

/**
 * A model-ready feature set derived from raw {@link CreditTelemetry} by the
 * {@link FeatureExtractor}.
 *
 * In a production ML credit pipeline this interface represents the output of a
 * feature store (Feast, Tecton, or a proprietary in-house system) — the computed,
 * validated representation that both the training pipeline and the online scoring
 * path consume identically. Centralising feature computation in one place enforces
 * training/serving parity: a feature computed differently at serving time from how
 * it was computed at training time silently degrades model performance on live
 * traffic without surfacing in offline evaluation metrics.
 *
 * The optional {@link FeatureVector.externalProbabilityOfDefault} field is the seam
 * through which a model serving endpoint (SageMaker, Seldon, BentoML) injects a PD
 * score without touching the engine, the audit ledger, or the adverse-action layer.
 *
 * @interface FeatureVector
 */
export interface FeatureVector {
  /** Tenant pool identifier — routing key, passed through from telemetry. */
  readonly tenantId: string;
  /** Account identifier — passed through from telemetry. */
  readonly accountId: string;

  // ── Raw signals ─────────────────────────────────────────────────────────────
  /** Transaction amount in USD cents. */
  readonly transactionAmountCents: number;
  /** ISO 18245 merchant category code. */
  readonly merchantCategoryCode: number;

  // ── Behavioral signals (online-served from feature store in production) ──────
  /** Consecutive months of on-time rent/mortgage payments. */
  readonly consecutiveRentMonths: number;
  /** Ratio of liquid cash reserves to average monthly spend. */
  readonly cashReserveRatio: number;
  /** Average daily spend over the trailing 90-day window (USD cents). */
  readonly averageDailySpendCents: number;

  // ── Derived features (computed by FeatureExtractor; identical offline/online) ─
  /**
   * Spend velocity multiple: `transactionAmountCents / averageDailySpendCents`.
   * Pre-computing here ensures underwriting strategies and the anomaly guard
   * consume an identical, single-source value for the ratio — no divergence
   * between what the model was trained on and what it receives at inference time.
   */
  readonly spendVelocityMultiple: number;
  /**
   * Whether the MCC signals a quasi-cash or cash-equivalent transaction
   * (ATM: 6011, crypto/quasi-cash: 6051). Encoding as a boolean rather than
   * passing the raw MCC avoids numeric encoding artefacts in tree-based models
   * where the ordinal distance between MCC values is meaningless.
   */
  readonly isQuasiCashMerchant: boolean;

  // ── Optional: probability of default from an external model serving layer ────
  /**
   * Point-in-time probability of default (PD) from an external model serving
   * endpoint, in the range [0, 1]. Present when the pipeline is configured to
   * call a live scorer; absent for rule-based tracks.
   *
   * When populated, the {@link ModelBackedUnderwritingStrategy} translates this PD
   * to a score and a {@link ScoringFactor} list, letting the same engine, ledger,
   * and disclosure layer serve both rule-based and ML-backed decisioning with zero
   * modification to the orchestration layer.
   */
  readonly externalProbabilityOfDefault?: number;
}

/**
 * A single consumer credit telemetry event.
 *
 * Captured from real-time transaction streams and enriched with trailing
 * behavioral metrics. This payload is the sole input to both the underwriting
 * and anomaly-detection layers, which evaluate it independently and in parallel.
 *
 * @interface CreditTelemetry
 */
export interface CreditTelemetry {
  /** Tenant pool identifier: 'TIMS_MIGRATION_POOL' or 'NEO_NATIVE_SECURED' */
  tenantId: string;
  /** Unique account identifier within the tenant pool */
  accountId: string;
  /** Transaction amount in USD cents (e.g., 5000 = $50.00) */
  amount: number;
  /** ISO 18245 merchant category code (MCC) classifying the transaction */
  merchantCategoryCode: number;
  /** ISO 8601 timestamp of transaction capture */
  timestamp: string;
  /** Trailing behavioral metrics aggregated over the account lifecycle */
  historicalMetrics: {
    /** Average daily spend (USD cents) across the trailing 90-day window */
    averageDailySpend: number;
    /** Count of consecutive on-time rent/mortgage payments (months) */
    consecutiveRentPayments: number;
    /** Ratio of liquid cash reserves to average monthly spend */
    cashReserveRatio: number;
  };
}

/**
 * A single, auditable contribution to an underwriting score.
 *
 * Every point added or removed from a score is represented as an explicit factor
 * with a stable machine code and a human-readable description. This is the
 * substrate for regulatory adverse-action disclosure: when an applicant is
 * declined or rated subprime, the limiting factors are surfaced verbatim rather
 * than reverse-engineered from an opaque score.
 *
 * @interface ScoringFactor
 */
export interface ScoringFactor {
  /** Stable machine-readable factor code (e.g., 'CASH_RESERVE_DEFICIENT') */
  code: string;
  /** Human-readable explanation suitable for adverse-action disclosure */
  description: string;
  /** Signed point contribution to the raw score (may be zero, positive, or negative) */
  points: number;
}

/**
 * The complete, transparent output of a single underwriting strategy.
 *
 * Carries both the un-clamped raw score (for auditability of the additive model)
 * and the clamped score actually used for tiering, plus the full factor list.
 *
 * @interface ScoreBreakdown
 */
export interface ScoreBreakdown {
  /** Sum of all factor points prior to bounds clamping */
  rawScore: number;
  /** Score clamped to the valid [0, 100] range */
  clampedScore: number;
  /** Ordered list of every factor that contributed to the score */
  factors: ScoringFactor[];
}

/**
 * The decision rendered by the underwriting engine for a single telemetry event.
 *
 * Fully self-describing for audit and compliance: it names the strategy track
 * that produced it, carries the complete factor breakdown, and — when the outcome
 * is adverse — the principal reasons a regulator or applicant would require.
 *
 * @interface UnderwritingResult
 */
export interface UnderwritingResult {
  /** Deterministic, content-derived decision identifier (e.g., 'DEC-3F9A1C0B7E22') */
  decisionId: string;
  /** Tenant pool identifier from the input telemetry */
  tenantId: string;
  /** Account identifier from the input telemetry */
  accountId: string;
  /** Identifier of the underwriting strategy/track that produced this decision */
  underwritingTrack: string;
  /** Numeric risk score (0-100) */
  neoRiskScore: number;
  /** Categorical risk classification derived from the score */
  riskTier: RiskTier;
  /** Complete, ordered factor breakdown for full decision transparency */
  factors: ScoringFactor[];
  /**
   * Principal adverse-action reasons. Populated only for HIGH/DECLINE outcomes;
   * empty for approvals. Ordered by severity (most score-suppressing first).
   */
  adverseActionReasons: string[];
  /** ISO 8601 timestamp when the decision was rendered */
  calculatedAt: string;
}

/**
 * Flags a telemetry event as an immediate threat to securitized asset quality.
 *
 * Produced by deterministic, rules-based guards (velocity, cash-out) that protect
 * institutional credit pools from fraud and compliance degradation independently
 * of the creditworthiness decision.
 *
 * @interface AnomalyFlag
 */
export interface AnomalyFlag {
  /** Stable identifier of the rule that fired (e.g., 'VELOCITY_BUST_OUT') */
  ruleId: string;
  /** Tenant pool identifier */
  tenantId: string;
  /** Account identifier */
  accountId: string;
  /** Severity level: 'HIGH' (investigate) or 'CRITICAL' (immediate action) */
  riskLevel: AnomalyRiskLevel;
  /** Human-readable explanation of the triggered rule */
  reason: string;
  /** ISO 8601 timestamp when the flag was raised */
  flaggedAt: string;
}
