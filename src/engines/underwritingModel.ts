/**
 * @fileoverview Underwriting orchestration engine for the Neo Risk Pipeline.
 *
 * This engine owns no scoring logic of its own. Its responsibilities are
 * dispatch, classification, and disclosure:
 *  1. Route each telemetry event to the {@link UnderwritingStrategy} calibrated
 *     for its tenant pool (falling back to a conservative default for unknown
 *     pools — fail-closed, never fail-open, for a risk system).
 *  2. Map the resulting score to a regulatory risk tier.
 *  3. Derive adverse-action reasons for non-approval outcomes.
 *  4. Stamp the decision with a deterministic, content-derived identifier.
 *
 * Strategies are injected via the constructor (dependency inversion), so the
 * engine is closed for modification but open for extension: new pools require a
 * new strategy, never a change here.
 */

import { createHash } from 'node:crypto';
import type {
  CreditTelemetry,
  UnderwritingResult,
  RiskTier,
  ScoringFactor,
} from '../types/index.js';
import type { UnderwritingStrategy } from '../strategies/underwritingStrategy.js';
import { FeatureExtractor } from '../features/featureExtractor.js';
import { RISK_PARAMETERS } from '../config/riskParameters.js';

const TIERS = RISK_PARAMETERS.underwriting.tiers;

/**
 * Routes telemetry to pool-specific underwriting strategies and renders a
 * fully disclosed {@link UnderwritingResult}.
 *
 * @class UnderwritingEngine
 */
export class UnderwritingEngine {
  /** Resolution table from tenant pool identifier to its underwriting strategy. */
  private readonly strategiesByTenant: ReadonlyMap<string, UnderwritingStrategy>;

  /** Conservative fallback strategy for telemetry from an unrecognized pool. */
  private readonly defaultStrategy: UnderwritingStrategy;

  /**
   * Computes the model-ready feature vector from raw telemetry before dispatch.
   * Instantiated internally: the extractor is stateless and has no dependencies,
   * so there is no value in injecting it — doing so would expose an implementation
   * detail of the engine's internal pipeline to callers who have no use for it.
   */
  private readonly featureExtractor = new FeatureExtractor();

  /**
   * @param strategies - The pool-specific strategies to register. Each is keyed
   *   by its `supportedTenantId`.
   * @param defaultStrategy - The strategy applied when no registered strategy
   *   matches the telemetry's tenant. Choose the most conservative track so that
   *   unknown pools fail closed.
   */
  constructor(strategies: readonly UnderwritingStrategy[], defaultStrategy: UnderwritingStrategy) {
    this.strategiesByTenant = new Map(
      strategies.map((strategy) => [strategy.supportedTenantId, strategy] as const),
    );
    this.defaultStrategy = defaultStrategy;
  }

  /**
   * Evaluates a single telemetry event and returns a complete decision.
   *
   * @param telemetry - The consumer credit telemetry event to underwrite.
   * @returns The rendered underwriting decision, including factor breakdown and
   *   any adverse-action reasons.
   */
  public evaluate(telemetry: CreditTelemetry): UnderwritingResult {
    const strategy = this.strategiesByTenant.get(telemetry.tenantId) ?? this.defaultStrategy;
    const features = this.featureExtractor.extract(telemetry);
    const breakdown = strategy.score(features);
    const riskTier = this.classify(breakdown.clampedScore);
    const adverseActionReasons = this.deriveAdverseActionReasons(breakdown.factors, riskTier);

    return {
      decisionId: this.generateDecisionId(telemetry, breakdown.clampedScore),
      tenantId: telemetry.tenantId,
      accountId: telemetry.accountId,
      underwritingTrack: strategy.trackName,
      neoRiskScore: breakdown.clampedScore,
      riskTier,
      factors: breakdown.factors,
      adverseActionReasons,
      calculatedAt: new Date().toISOString(),
    };
  }

  /**
   * Maps a numeric score to its categorical risk tier. Boundaries are inclusive
   * lower bounds evaluated from highest to lowest.
   *
   * @param score - The clamped risk score in [0, 100].
   * @returns The corresponding {@link RiskTier}.
   */
  private classify(score: number): RiskTier {
    if (score >= TIERS.lowMin) return 'LOW';
    if (score >= TIERS.mediumMin) return 'MEDIUM';
    if (score >= TIERS.highMin) return 'HIGH';
    return 'DECLINE';
  }

  /**
   * Derives the principal reasons for an adverse outcome from the factor list.
   *
   * Only non-approval tiers (HIGH, DECLINE) carry adverse-action reasons. The
   * reasons are the factors that failed to raise the score (zero or negative
   * contribution), ordered most-suppressing first — the disclosure a regulator
   * or applicant requires under adverse-action rules.
   *
   * @param factors - The complete factor breakdown for the decision.
   * @param tier - The classified risk tier.
   * @returns Ordered adverse-action reason descriptions; empty for approvals.
   */
  private deriveAdverseActionReasons(factors: readonly ScoringFactor[], tier: RiskTier): string[] {
    if (tier !== 'HIGH' && tier !== 'DECLINE') return [];
    return factors
      .filter((factor) => factor.points <= 0)
      .slice()
      .sort((a, b) => a.points - b.points)
      .map((factor) => factor.description);
  }

  /**
   * Produces a deterministic, content-derived decision identifier.
   *
   * The identifier is a truncated SHA-256 digest over the immutable identifying
   * fields of the decision. Determinism means the same decision is always
   * addressable by the same id across re-runs, supporting idempotent downstream
   * processing and audit reconciliation.
   *
   * @param telemetry - The source telemetry event.
   * @param score - The clamped score, included to bind the id to the outcome.
   * @returns A decision identifier of the form `DEC-XXXXXXXXXXXX`.
   */
  private generateDecisionId(telemetry: CreditTelemetry, score: number): string {
    const digest = createHash('sha256')
      .update(`${telemetry.tenantId}|${telemetry.accountId}|${telemetry.timestamp}|${score}`)
      .digest('hex');
    return `DEC-${digest.slice(0, 12).toUpperCase()}`;
  }
}
