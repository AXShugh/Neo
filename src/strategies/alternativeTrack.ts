/**
 * @fileoverview Alternative-data underwriting strategy for the TIMS migration pool.
 *
 * Implements credit assessment for applicants with thin or absent traditional
 * credit files. Rather than a FICO score, the model evaluates behavioral proxies
 * for repayment capacity and willingness — consecutive rent-payment discipline
 * and cash-reserve adequacy — that are predictive of performance yet invisible to
 * the bureau-based system. This is the mechanism by which previously unscorable
 * consumers are responsibly admitted to a securitizable asset pool.
 *
 * Scoring is purely additive and fully transparent: every adjustment is emitted
 * as a {@link ScoringFactor}, including the zero-point "missed bonus" factors that
 * become adverse-action reasons on a decline.
 */

import type { FeatureVector, ScoreBreakdown, ScoringFactor } from '../types/index.js';
import type { UnderwritingStrategy } from './underwritingStrategy.js';
import { RISK_PARAMETERS } from '../config/riskParameters.js';

const TRACK = RISK_PARAMETERS.underwriting.alternativeTrack;
const BOUNDS = RISK_PARAMETERS.underwriting.scoreBounds;

/**
 * Behavioral, alternative-data scoring model for `TIMS_MIGRATION_POOL`.
 *
 * Model:
 * - Base: 50 (neutral starting point for a thin-file applicant).
 * - Rent history: +35 if > 20 months, else +25 if > 12 months, else 0.
 * - Cash reserves: +15 if ≥ 3.0x, −20 if < 1.0x, else 0.
 *
 * @class AlternativeUnderwritingStrategy
 */
export class AlternativeUnderwritingStrategy implements UnderwritingStrategy {
  public readonly trackName = 'ALTERNATIVE_DATA_V1';
  public readonly supportedTenantId = 'TIMS_MIGRATION_POOL';

  /**
   * Scores a telemetry event against the alternative-data model.
   *
   * @param telemetry - The consumer credit telemetry event to evaluate.
   * @returns A transparent breakdown: raw score, clamped score, and all factors.
   */
  public score(features: FeatureVector): ScoreBreakdown {
    const { consecutiveRentMonths: consecutiveRentPayments, cashReserveRatio } = features;
    const factors: ScoringFactor[] = [];

    factors.push({
      code: 'BASE_THIN_FILE',
      description: 'Baseline score for thin-file / no-FICO applicant',
      points: TRACK.baseScore,
    });

    // Rent-payment discipline — the strongest behavioral predictor in this model.
    // Bounds are exclusive (`>`), matching the model specification exactly.
    if (consecutiveRentPayments > TRACK.rent.strongMonths) {
      factors.push({
        code: 'RENT_HISTORY_STRONG',
        description: `${TRACK.rent.strongMonths}+ months of consecutive on-time rent payments`,
        points: TRACK.rent.strongBonus,
      });
    } else if (consecutiveRentPayments > TRACK.rent.moderateMonths) {
      factors.push({
        code: 'RENT_HISTORY_MODERATE',
        description: `${TRACK.rent.moderateMonths}+ months of consecutive on-time rent payments`,
        points: TRACK.rent.moderateBonus,
      });
    } else {
      factors.push({
        code: 'RENT_HISTORY_INSUFFICIENT',
        description: `Fewer than ${TRACK.rent.moderateMonths + 1} months of qualifying rent history`,
        points: 0,
      });
    }

    // Cash-reserve adequacy — a proxy for resilience to income shocks.
    if (cashReserveRatio >= TRACK.reserve.bonusRatio) {
      factors.push({
        code: 'CASH_RESERVE_STRONG',
        description: `Cash reserves at or above ${TRACK.reserve.bonusRatio.toFixed(1)}x monthly spend`,
        points: TRACK.reserve.bonus,
      });
    } else if (cashReserveRatio < TRACK.reserve.penaltyRatio) {
      factors.push({
        code: 'CASH_RESERVE_DEFICIENT',
        description: `Cash reserve ratio below ${TRACK.reserve.penaltyRatio.toFixed(1)}x minimum threshold`,
        points: -TRACK.reserve.penalty,
      });
    } else {
      factors.push({
        code: 'CASH_RESERVE_ADEQUATE',
        description: `Cash reserves adequate but below ${TRACK.reserve.bonusRatio.toFixed(1)}x bonus threshold`,
        points: 0,
      });
    }

    const rawScore = factors.reduce((sum, factor) => sum + factor.points, 0);
    const clampedScore = Math.max(BOUNDS.min, Math.min(BOUNDS.max, rawScore));

    return { rawScore, clampedScore, factors };
  }
}
