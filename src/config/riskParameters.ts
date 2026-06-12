/**
 * @fileoverview Centralized, immutable risk parameterization for the pipeline.
 *
 * Every threshold, weight, and bound used by the underwriting strategies and the
 * securitization guard is declared here exactly once. No magic numbers are
 * embedded in business logic. This is a deliberate architectural choice: in a
 * regulated lending system, risk parameters are the subject of model-governance
 * review, periodic recalibration, and change-control audit. Co-locating them in a
 * single frozen, typed surface makes the model's behavior fully inspectable and
 * makes recalibration a one-file, reviewable diff.
 *
 * The `as const` assertion freezes the literal types, preventing accidental
 * mutation and giving callers compile-time-exact values.
 */

/**
 * Immutable risk parameter set governing all scoring and detection behavior.
 *
 * Sections:
 * - `underwriting.tiers`            — score boundaries for tier classification
 * - `underwriting.scoreBounds`      — valid score range for clamping
 * - `underwriting.alternativeTrack` — thin-file / no-FICO behavioral model
 * - `underwriting.traditionalTrack` — collateral-backed secured-product model
 * - `anomaly.velocity`             — bust-out fraud velocity detection
 * - `anomaly.cashOut`              — liquidity-extraction / cash-out detection
 */
export const RISK_PARAMETERS = {
  underwriting: {
    /** Inclusive lower bounds for each tier; evaluated high-to-low. */
    tiers: {
      lowMin: 80,
      mediumMin: 60,
      highMin: 40,
    },
    /** Valid score range. Raw additive scores are clamped into this interval. */
    scoreBounds: {
      min: 0,
      max: 100,
    },
    /**
     * Alternative-data track for the TIMS migration pool.
     * Calibrated for applicants with thin or absent traditional credit files,
     * substituting rent-payment discipline and reserve adequacy for a FICO score.
     */
    alternativeTrack: {
      baseScore: 50,
      rent: {
        /** Exclusive lower bound (months) for the strong rent-history bonus. */
        strongMonths: 20,
        strongBonus: 35,
        /** Exclusive lower bound (months) for the moderate rent-history bonus. */
        moderateMonths: 12,
        moderateBonus: 25,
      },
      reserve: {
        /** Inclusive lower bound for the reserve-adequacy bonus. */
        bonusRatio: 3.0,
        bonus: 15,
        /** Exclusive upper bound below which a liquidity penalty applies. */
        penaltyRatio: 1.0,
        /** Magnitude of the penalty (applied as a negative contribution). */
        penalty: 20,
      },
    },
    /**
     * Traditional track for the Neo-native secured pool.
     * Secured products are collateral-backed, which structurally lowers
     * loss-given-default; the model therefore begins from a higher base and
     * rewards reserve adequacy and in-pattern spending rather than rent history.
     */
    traditionalTrack: {
      baseScore: 70,
      reserve: {
        /** Inclusive lower bound for the strong-reserve bonus. */
        strongRatio: 3.0,
        strongBonus: 15,
        /** Inclusive lower bound for the adequate-reserve bonus. */
        adequateRatio: 1.5,
        adequateBonus: 10,
        /** Exclusive upper bound below which a liquidity penalty applies. */
        deficientRatio: 1.0,
        deficientPenalty: 20,
      },
      spendStability: {
        /** Transactions at or below this multiple of baseline earn a stability bonus. */
        maxBaselineMultiple: 1.5,
        bonus: 5,
      },
    },
  },
  anomaly: {
    velocity: {
      /** A transaction strictly exceeding this multiple of average daily spend trips the guard. */
      spendMultiple: 5,
    },
    cashOut: {
      /** MCC 6011 — automated cash disbursement (ATM). */
      atmMcc: 6011,
      /** MCC 6051 — quasi-cash, non-financial institutions (crypto, money orders). */
      quasiCashMcc: 6051,
      /** Cash-out amount (USD cents) strictly above which a leak is flagged ($2,000.00). */
      thresholdCents: 200_000,
    },
  },
} as const;
