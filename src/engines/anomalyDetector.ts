/**
 * @fileoverview Securitization guard (anomaly detection) engine.
 *
 * Protects institutional and bank-partner asset credit pools from
 * sudden credit events, fraud, and compliance degradation — independently of the
 * creditworthiness decision. A transaction can be approved on credit merit yet
 * still be flagged here for compliance review; the two layers answer different
 * questions and must not be conflated.
 *
 * All thresholds are sourced from {@link RISK_PARAMETERS}; this module contains
 * only the detection logic, not the calibration.
 */

import type { CreditTelemetry, AnomalyFlag } from '../types/index.js';
import { RISK_PARAMETERS } from '../config/riskParameters.js';

const VELOCITY = RISK_PARAMETERS.anomaly.velocity;
const CASH_OUT = RISK_PARAMETERS.anomaly.cashOut;

/**
 * Formats an integer USD-cents amount as a fixed-precision dollar string.
 *
 * @param cents - The amount in integer USD cents.
 * @returns The amount rendered as dollars (e.g., 450000 → "4500.00").
 */
function formatDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Applies deterministic securitization-protection rules to a telemetry event.
 *
 * Rules are evaluated in severity order; the first to fire wins, so a single
 * event yields at most one flag (the most severe). This mirrors real settlement
 * gating, where a CRITICAL hold supersedes a HIGH review.
 *
 * @class SecuritizationGuardEngine
 */
export class SecuritizationGuardEngine {
  /**
   * Evaluates a telemetry event and returns a flag if any rule fires.
   *
   * @param telemetry - The consumer credit telemetry event to inspect.
   * @returns An {@link AnomalyFlag} if a rule fired; otherwise `null`.
   */
  public detect(telemetry: CreditTelemetry): AnomalyFlag | null {
    const { amount, merchantCategoryCode, historicalMetrics, accountId, tenantId } = telemetry;
    const { averageDailySpend } = historicalMetrics;
    const flaggedAt = new Date().toISOString();

    // Rule 1 — Velocity check (CRITICAL): a transaction strictly exceeding 5x the
    // account's average daily spend is the canonical bust-out fraud signature.
    const velocityThreshold = averageDailySpend * VELOCITY.spendMultiple;
    if (amount > velocityThreshold) {
      return {
        ruleId: 'VELOCITY_BUST_OUT',
        tenantId,
        accountId,
        riskLevel: 'CRITICAL',
        reason:
          `Bust-out fraud signature: transaction $${formatDollars(amount)} exceeds ` +
          `${VELOCITY.spendMultiple}x average daily spend ($${formatDollars(averageDailySpend)}). ` +
          `Immediate asset-pool protection required.`,
        flaggedAt,
      };
    }

    // Rule 2 — Cash-out leak (HIGH): ATM (6011) or quasi-cash/crypto (6051)
    // disbursement strictly above the threshold signals unauthorized liquidity
    // extraction that degrades the credit quality of the securitized pool.
    const isCashOutChannel =
      merchantCategoryCode === CASH_OUT.atmMcc || merchantCategoryCode === CASH_OUT.quasiCashMcc;
    if (isCashOutChannel && amount > CASH_OUT.thresholdCents) {
      const channel = merchantCategoryCode === CASH_OUT.atmMcc ? 'ATM cash-out' : 'quasi-cash / crypto';
      return {
        ruleId: 'CASH_OUT_LEAK',
        tenantId,
        accountId,
        riskLevel: 'HIGH',
        reason:
          `Cash-out leak: ${channel} transaction of $${formatDollars(amount)} exceeds ` +
          `$${formatDollars(CASH_OUT.thresholdCents)} threshold. ` +
          `Potential unauthorized liquidity extraction from securitized pool.`,
        flaggedAt,
      };
    }

    // No rule fired — the event is clean from a securitization-protection view.
    return null;
  }
}
