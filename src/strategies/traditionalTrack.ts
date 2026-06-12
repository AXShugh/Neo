/**
 * @fileoverview Traditional underwriting strategy for the Neo-native secured pool.
 *
 * Implements credit assessment for `NEO_NATIVE_SECURED` accounts — collateral-
 * backed secured products whose deposit collateral structurally reduces
 * loss-given-default. Because these borrowers are not thin-file migrants, rent
 * history is not the operative signal; the model instead rewards reserve adequacy
 * and in-pattern spending behavior, beginning from a higher base that reflects the
 * collateralized risk profile.
 *
 * This separation is the architectural answer to a subtle but important defect:
 * scoring a conventional secured borrower on a thin-file behavioral model would
 * mislabel a low-risk account as subprime purely for lacking rent-payment
 * telemetry it was never expected to have. Routing by pool eliminates that
 * category error.
 */

import type { FeatureVector, ScoreBreakdown, ScoringFactor } from '../types/index.js';
import type { UnderwritingStrategy } from './underwritingStrategy.js';
import { RISK_PARAMETERS } from '../config/riskParameters.js';

const TRACK = RISK_PARAMETERS.underwriting.traditionalTrack;
const BOUNDS = RISK_PARAMETERS.underwriting.scoreBounds;

/**
 * Collateral-backed scoring model for `NEO_NATIVE_SECURED`.
 *
 * Model:
 * - Base: 70 (collateralized product → lower loss-given-default).
 * - Cash reserves: +15 if ≥ 3.0x, +10 if ≥ 1.5x, −20 if < 1.0x, else 0.
 * - Spend stability: +5 if the transaction is within 1.5x of baseline spend.
 *
 * @class TraditionalUnderwritingStrategy
 */
export class TraditionalUnderwritingStrategy implements UnderwritingStrategy {
  public readonly trackName = 'TRADITIONAL_SECURED_V1';
  public readonly supportedTenantId = 'NEO_NATIVE_SECURED';

  /**
   * Scores a telemetry event against the traditional secured model.
   *
   * @param telemetry - The consumer credit telemetry event to evaluate.
   * @returns A transparent breakdown: raw score, clamped score, and all factors.
   */
  public score(features: FeatureVector): ScoreBreakdown {
    const { cashReserveRatio, averageDailySpendCents: averageDailySpend, transactionAmountCents: amount } = features;
    const factors: ScoringFactor[] = [];

    factors.push({
      code: 'BASE_SECURED',
      description: 'Baseline score for collateral-backed secured product',
      points: TRACK.baseScore,
    });

    // Cash-reserve adequacy — graduated bands reflecting buffer strength.
    if (cashReserveRatio >= TRACK.reserve.strongRatio) {
      factors.push({
        code: 'CASH_RESERVE_STRONG',
        description: `Cash reserves at or above ${TRACK.reserve.strongRatio.toFixed(1)}x monthly spend`,
        points: TRACK.reserve.strongBonus,
      });
    } else if (cashReserveRatio >= TRACK.reserve.adequateRatio) {
      factors.push({
        code: 'CASH_RESERVE_ADEQUATE',
        description: `Cash reserves between ${TRACK.reserve.adequateRatio.toFixed(1)}x and ${TRACK.reserve.strongRatio.toFixed(1)}x monthly spend`,
        points: TRACK.reserve.adequateBonus,
      });
    } else if (cashReserveRatio < TRACK.reserve.deficientRatio) {
      factors.push({
        code: 'CASH_RESERVE_DEFICIENT',
        description: `Cash reserve ratio below ${TRACK.reserve.deficientRatio.toFixed(1)}x minimum threshold`,
        points: -TRACK.reserve.deficientPenalty,
      });
    } else {
      factors.push({
        code: 'CASH_RESERVE_THIN',
        description: `Cash reserves between ${TRACK.reserve.deficientRatio.toFixed(1)}x and ${TRACK.reserve.adequateRatio.toFixed(1)}x monthly spend`,
        points: 0,
      });
    }

    // Spend stability — a transaction in line with the established baseline is a
    // signal of consistent, predictable behavior. Bound is inclusive (`<=`).
    const baselineCeiling = averageDailySpend * TRACK.spendStability.maxBaselineMultiple;
    if (amount <= baselineCeiling) {
      factors.push({
        code: 'SPEND_PATTERN_STABLE',
        description: `Transaction within ${TRACK.spendStability.maxBaselineMultiple}x of established spend baseline`,
        points: TRACK.spendStability.bonus,
      });
    } else {
      factors.push({
        code: 'SPEND_PATTERN_ELEVATED',
        description: `Transaction exceeds ${TRACK.spendStability.maxBaselineMultiple}x established spend baseline`,
        points: 0,
      });
    }

    const rawScore = factors.reduce((sum, factor) => sum + factor.points, 0);
    const clampedScore = Math.max(BOUNDS.min, Math.min(BOUNDS.max, rawScore));

    return { rawScore, clampedScore, factors };
  }
}
