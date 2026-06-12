/**
 * @fileoverview Telemetry stream ingestion layer for the Neo Risk Pipeline.
 *
 * Simulates real-time transaction and account-state ingestion from multiple
 * tenant pools via an async generator — the same shape a production consumer
 * would expose over Kafka/Kinesis, allowing the orchestrator to remain identical
 * whether the source is a mock or a live broker.
 *
 * The mock profiles are not arbitrary: each is engineered to exercise a distinct
 * path through the underwriting strategies and the securitization guard, so a
 * single run demonstrates the full behavioral surface of the pipeline. Expected
 * outcomes are stated precisely and traced to the model parameters in
 * `config/riskParameters.ts`.
 */

import type { CreditTelemetry } from '../types/index.js';

/**
 * Streams realistic consumer credit telemetry for pipeline demonstration and
 * integration testing.
 *
 * @class TelemetryStreamer
 */
export class TelemetryStreamer {
  /**
   * Engineered consumer profiles, each targeting a specific code path.
   *
   * @private
   */
  private readonly profiles: readonly CreditTelemetry[] = [
    /**
     * Profile A — Alternative-data approval (the inclusion thesis).
     * Pool: TIMS_MIGRATION_POOL → ALTERNATIVE_DATA_V1
     *
     * A no-FICO entrepreneur with 24 months of perfect rent payments and 4.5x
     * reserves. Demonstrates that strong behavioral proxies can fully substitute
     * for an absent bureau score.
     *
     * Expected: 50 (base) + 35 (> 20mo rent) + 15 (≥ 3.0x reserve) = 100 → LOW.
     * Anomaly: none ($150 transaction equals baseline spend).
     */
    {
      tenantId: 'TIMS_MIGRATION_POOL',
      accountId: 'ALT_CREDIT_001',
      amount: 15_000, // $150.00
      merchantCategoryCode: 5411, // Grocery stores
      timestamp: new Date('2026-06-11T08:32:15Z').toISOString(),
      historicalMetrics: {
        averageDailySpend: 15_000, // $150.00
        consecutiveRentPayments: 24,
        cashReserveRatio: 4.5,
      },
    },

    /**
     * Profile B — Standard secured approval (the routing payoff).
     * Pool: NEO_NATIVE_SECURED → TRADITIONAL_SECURED_V1
     *
     * A conventional secured borrower with no rent-history telemetry and adequate
     * (1.8x) reserves, spending in line with baseline. Under a thin-file model
     * this account would be mislabeled subprime purely for lacking rent data it
     * was never expected to have; routing to the secured track scores it LOW for
     * the correct structural reason (collateral-backed, adequate reserves,
     * in-pattern spend).
     *
     * Expected: 70 (base) + 10 (1.5–3.0x reserve) + 5 (spend ≤ 1.5x baseline)
     *           = 85 → LOW.
     * Anomaly: none.
     */
    {
      tenantId: 'NEO_NATIVE_SECURED',
      accountId: 'STD_CREDIT_002',
      amount: 8_500, // $85.00
      merchantCategoryCode: 5814, // Fast food restaurants
      timestamp: new Date('2026-06-11T12:47:22Z').toISOString(),
      historicalMetrics: {
        averageDailySpend: 8_500, // $85.00
        consecutiveRentPayments: 0,
        cashReserveRatio: 1.8,
      },
    },

    /**
     * Profile C — Bust-out fraud (the asset-pool protection case).
     * Pool: TIMS_MIGRATION_POOL → ALTERNATIVE_DATA_V1
     *
     * A $4,500 transaction at 8x the account's $562.50 baseline — the canonical
     * bust-out signature against a securitized pool — paired with deficient (0.8x)
     * reserves and only 12 months of rent history (one short of the bonus band).
     *
     * Expected underwriting: 50 (base) + 0 (12mo not > 12) − 20 (< 1.0x reserve)
     *                        = 30 → DECLINE, with adverse-action reasons.
     * Expected anomaly: CRITICAL (velocity; $4,500 > 5 × $562.50 = $2,812.50).
     */
    {
      tenantId: 'TIMS_MIGRATION_POOL',
      accountId: 'FRAUD_BUST_OUT_003',
      amount: 450_000, // $4,500.00 — 8x baseline
      merchantCategoryCode: 5411, // Grocery stores
      timestamp: new Date('2026-06-11T15:19:43Z').toISOString(),
      historicalMetrics: {
        averageDailySpend: 56_250, // $562.50 baseline
        consecutiveRentPayments: 12,
        cashReserveRatio: 0.8,
      },
    },

    /**
     * Profile D — Approved-but-flagged (independence of the two layers).
     * Pool: NEO_NATIVE_SECURED → TRADITIONAL_SECURED_V1
     *
     * A $2,500 quasi-cash/crypto (MCC 6051) purchase by a borrower with a $600/day
     * baseline. The amount is elevated (4.17x) but below the 5x velocity line, so
     * it is approved on credit merit — yet it trips the cash-out leak rule. This
     * proves the underwriting and guard layers answer different questions: a
     * creditworthy account can still require compliance review.
     *
     * Expected underwriting: 70 (base) + 10 (2.0x reserve) + 0 (spend > 1.5x)
     *                        = 80 → LOW.
     * Expected anomaly: HIGH (cash-out; MCC 6051 and $2,500 > $2,000).
     */
    {
      tenantId: 'NEO_NATIVE_SECURED',
      accountId: 'CASH_OUT_LEAK_004',
      amount: 250_000, // $2,500.00
      merchantCategoryCode: 6051, // Quasi-cash / crypto
      timestamp: new Date('2026-06-11T17:05:09Z').toISOString(),
      historicalMetrics: {
        averageDailySpend: 60_000, // $600.00
        consecutiveRentPayments: 0,
        cashReserveRatio: 2.0,
      },
    },

    /**
     * Profile E — Exclusive-boundary case (off-by-one correctness).
     * Pool: TIMS_MIGRATION_POOL → ALTERNATIVE_DATA_V1
     *
     * Sits exactly on two exclusive thresholds: 12 months rent (bonus requires
     * > 12) and a 1.0x reserve ratio (penalty requires < 1.0). A correct
     * implementation grants neither the bonus nor the penalty, demonstrating that
     * the boundary comparisons are strict as specified.
     *
     * Expected underwriting: 50 (base) + 0 (rent = 12) + 0 (reserve = 1.0)
     *                        = 50 → HIGH, with adverse-action reasons.
     * Expected anomaly: none.
     */
    {
      tenantId: 'TIMS_MIGRATION_POOL',
      accountId: 'EDGE_BOUNDARY_005',
      amount: 20_000, // $200.00
      merchantCategoryCode: 5411, // Grocery stores
      timestamp: new Date('2026-06-11T19:41:58Z').toISOString(),
      historicalMetrics: {
        averageDailySpend: 20_000, // $200.00
        consecutiveRentPayments: 12,
        cashReserveRatio: 1.0,
      },
    },

    // ── EXTENDED MOCK PORTFOLIO ────────────────────────────────────────────────
    // 15 additional profiles that populate every tier, both pools, and all
    // anomaly paths — giving the dashboard a realistic portfolio distribution.

    /**
     * Profile F — Strong alt-data approval.
     * Pool: TIMS_MIGRATION_POOL → ALTERNATIVE_DATA_V1
     * Expected: 50 + 35 (> 20mo rent) + 15 (≥ 3.0x reserve) = 100 → LOW.
     * Anomaly: none.
     */
    {
      tenantId: 'TIMS_MIGRATION_POOL',
      accountId: 'TIMS_ALT_006',
      amount: 8_500, // $85.00
      merchantCategoryCode: 5411, // Grocery stores
      timestamp: new Date('2026-06-11T08:15:22Z').toISOString(),
      historicalMetrics: {
        averageDailySpend: 9_000, // $90.00
        consecutiveRentPayments: 22,
        cashReserveRatio: 3.8,
      },
    },

    /**
     * Profile G — Moderate rent history, medium tier.
     * Pool: TIMS_MIGRATION_POOL → ALTERNATIVE_DATA_V1
     * Expected: 50 + 25 (> 12mo) + 0 = 75 → MEDIUM.
     * Anomaly: none.
     */
    {
      tenantId: 'TIMS_MIGRATION_POOL',
      accountId: 'TIMS_ALT_007',
      amount: 5_500, // $55.00
      merchantCategoryCode: 5541, // Service stations / gas
      timestamp: new Date('2026-06-11T09:03:44Z').toISOString(),
      historicalMetrics: {
        averageDailySpend: 6_000, // $60.00
        consecutiveRentPayments: 16,
        cashReserveRatio: 2.5,
      },
    },

    /**
     * Profile H — Early-stage rent builder, medium tier.
     * Pool: TIMS_MIGRATION_POOL → ALTERNATIVE_DATA_V1
     * Expected: 50 + 25 (> 12mo) + 0 = 75 → MEDIUM.
     * Anomaly: none.
     */
    {
      tenantId: 'TIMS_MIGRATION_POOL',
      accountId: 'TIMS_ALT_008',
      amount: 4_200, // $42.00
      merchantCategoryCode: 5912, // Drug stores / pharmacies
      timestamp: new Date('2026-06-11T09:47:11Z').toISOString(),
      historicalMetrics: {
        averageDailySpend: 4_500, // $45.00
        consecutiveRentPayments: 14,
        cashReserveRatio: 1.2,
      },
    },

    /**
     * Profile I — No rent history, deficient reserves → decline.
     * Pool: TIMS_MIGRATION_POOL → ALTERNATIVE_DATA_V1
     * Expected: 50 + 0 + (−20) = 30 → DECLINE.
     * Anomaly: none.
     */
    {
      tenantId: 'TIMS_MIGRATION_POOL',
      accountId: 'TIMS_ALT_009',
      amount: 3_500, // $35.00
      merchantCategoryCode: 5411, // Grocery stores
      timestamp: new Date('2026-06-11T10:22:38Z').toISOString(),
      historicalMetrics: {
        averageDailySpend: 4_000, // $40.00
        consecutiveRentPayments: 0,
        cashReserveRatio: 0.7,
      },
    },

    /**
     * Profile J — Short rent history, adequate reserves → subprime.
     * Pool: TIMS_MIGRATION_POOL → ALTERNATIVE_DATA_V1
     * Expected: 50 + 0 (9mo not > 12) + 0 = 50 → HIGH.
     * Anomaly: none.
     */
    {
      tenantId: 'TIMS_MIGRATION_POOL',
      accountId: 'TIMS_ALT_010',
      amount: 7_500, // $75.00
      merchantCategoryCode: 5814, // Fast food restaurants
      timestamp: new Date('2026-06-11T11:05:55Z').toISOString(),
      historicalMetrics: {
        averageDailySpend: 7_000, // $70.00
        consecutiveRentPayments: 9,
        cashReserveRatio: 1.5,
      },
    },

    /**
     * Profile K — Approved thin-file account, large ATM withdrawal.
     * Pool: TIMS_MIGRATION_POOL → ALTERNATIVE_DATA_V1
     * Credit merit: 50 + 35 (> 20mo) + 15 (≥ 3.0x) = 100 → LOW.
     * Guard: MCC 6011 and $2,200 > $2,000 threshold → HIGH cash-out leak.
     * Demonstrates layer independence: creditworthy account still flagged for
     * compliance review on an unauthorized-liquidity-extraction pattern.
     */
    {
      tenantId: 'TIMS_MIGRATION_POOL',
      accountId: 'TIMS_ALT_011',
      amount: 220_000, // $2,200.00 — below 5× $600 velocity line but > $2,000 cash-out threshold
      merchantCategoryCode: 6011, // ATM cash advance
      timestamp: new Date('2026-06-11T13:15:29Z').toISOString(),
      historicalMetrics: {
        averageDailySpend: 60_000, // $600.00 — velocity ceiling = $3,000
        consecutiveRentPayments: 21,
        cashReserveRatio: 3.2,
      },
    },

    /**
     * Profile L — Bust-out on thin-file account.
     * Pool: TIMS_MIGRATION_POOL → ALTERNATIVE_DATA_V1
     * Credit merit: 50 + 0 (7mo) + (−20) = 30 → DECLINE.
     * Guard: $3,500 > 5 × $310 = $1,550 → CRITICAL velocity.
     */
    {
      tenantId: 'TIMS_MIGRATION_POOL',
      accountId: 'TIMS_ALT_012',
      amount: 350_000, // $3,500.00 — 11.3× baseline
      merchantCategoryCode: 5411, // Grocery stores
      timestamp: new Date('2026-06-11T14:44:07Z').toISOString(),
      historicalMetrics: {
        averageDailySpend: 31_000, // $310.00 baseline
        consecutiveRentPayments: 7,
        cashReserveRatio: 0.5,
      },
    },

    /**
     * Profile M — Premium secured account, strong reserves.
     * Pool: NEO_NATIVE_SECURED → TRADITIONAL_SECURED_V1
     * Expected: 70 + 15 (≥ 3.0x) + 5 (spend ≤ 1.5× baseline) = 90 → LOW.
     * Anomaly: none.
     */
    {
      tenantId: 'NEO_NATIVE_SECURED',
      accountId: 'SEC_NATIVE_013',
      amount: 9_500, // $95.00 — well within $150 × 1.5 = $225
      merchantCategoryCode: 5411, // Grocery stores
      timestamp: new Date('2026-06-11T16:22:51Z').toISOString(),
      historicalMetrics: {
        averageDailySpend: 15_000, // $150.00
        consecutiveRentPayments: 0,
        cashReserveRatio: 4.1,
      },
    },

    /**
     * Profile N — Solid secured, adequate reserves.
     * Pool: NEO_NATIVE_SECURED → TRADITIONAL_SECURED_V1
     * Expected: 70 + 10 (1.5–3.0× reserve) + 5 (spend ≤ 1.5× baseline) = 85 → LOW.
     * Anomaly: none.
     */
    {
      tenantId: 'NEO_NATIVE_SECURED',
      accountId: 'SEC_NATIVE_014',
      amount: 11_000, // $110.00 — within $120 × 1.5 = $180
      merchantCategoryCode: 5814, // Fast food restaurants
      timestamp: new Date('2026-06-11T17:33:18Z').toISOString(),
      historicalMetrics: {
        averageDailySpend: 12_000, // $120.00
        consecutiveRentPayments: 0,
        cashReserveRatio: 1.8,
      },
    },

    /**
     * Profile O — Secured, borderline reserve band → medium tier.
     * Pool: NEO_NATIVE_SECURED → TRADITIONAL_SECURED_V1
     * Expected: 70 + 0 (1.0 ≤ reserve < 1.5, no band) + 5 = 75 → MEDIUM.
     * Anomaly: none.
     */
    {
      tenantId: 'NEO_NATIVE_SECURED',
      accountId: 'SEC_NATIVE_015',
      amount: 18_000, // $180.00 — within $200 × 1.5 = $300
      merchantCategoryCode: 5699, // Clothing stores
      timestamp: new Date('2026-06-11T18:11:44Z').toISOString(),
      historicalMetrics: {
        averageDailySpend: 20_000, // $200.00
        consecutiveRentPayments: 0,
        cashReserveRatio: 1.1,
      },
    },

    /**
     * Profile P — Secured, elevated spend day → approved, no guard fire.
     * Pool: NEO_NATIVE_SECURED → TRADITIONAL_SECURED_V1
     * Expected: 70 + 10 (2.0× reserve) + 0 (spend > 1.5× baseline) = 80 → LOW.
     * Anomaly: none ($320 < $200 × 5 velocity floor).
     */
    {
      tenantId: 'NEO_NATIVE_SECURED',
      accountId: 'SEC_NATIVE_016',
      amount: 32_000, // $320.00 — 1.6× baseline, misses spend-stability bonus
      merchantCategoryCode: 5734, // Computer and electronics stores
      timestamp: new Date('2026-06-11T18:52:30Z').toISOString(),
      historicalMetrics: {
        averageDailySpend: 20_000, // $200.00
        consecutiveRentPayments: 0,
        cashReserveRatio: 2.0,
      },
    },

    /**
     * Profile Q — Secured, deficient reserves → high risk tier.
     * Pool: NEO_NATIVE_SECURED → TRADITIONAL_SECURED_V1
     * Expected: 70 + (−20) (< 1.0×) + 5 (spend ≤ 1.5× baseline) = 55 → HIGH.
     * Anomaly: none.
     */
    {
      tenantId: 'NEO_NATIVE_SECURED',
      accountId: 'SEC_NATIVE_017',
      amount: 6_000, // $60.00 — within $65 × 1.5 = $97.50
      merchantCategoryCode: 5411, // Grocery stores
      timestamp: new Date('2026-06-11T19:15:22Z').toISOString(),
      historicalMetrics: {
        averageDailySpend: 6_500, // $65.00
        consecutiveRentPayments: 0,
        cashReserveRatio: 0.6,
      },
    },

    /**
     * Profile R — Secured account, quasi-cash velocity bust-out.
     * Pool: NEO_NATIVE_SECURED → TRADITIONAL_SECURED_V1
     * Credit merit: 70 + 15 (≥ 3.0×) + 0 (spend >> baseline) = 85 → LOW.
     * Guard: $2,900 > 5 × $400 = $2,000 → CRITICAL velocity (velocity rule takes
     * precedence over cash-out, preventing double-flagging).
     */
    {
      tenantId: 'NEO_NATIVE_SECURED',
      accountId: 'SEC_NATIVE_018',
      amount: 290_000, // $2,900.00 — 7.25× baseline
      merchantCategoryCode: 6051, // Quasi-cash / crypto
      timestamp: new Date('2026-06-11T20:04:37Z').toISOString(),
      historicalMetrics: {
        averageDailySpend: 40_000, // $400.00 — velocity ceiling = $2,000
        consecutiveRentPayments: 0,
        cashReserveRatio: 3.2,
      },
    },

    /**
     * Profile S — Secured account, ATM cash-out below velocity threshold.
     * Pool: NEO_NATIVE_SECURED → TRADITIONAL_SECURED_V1
     * Credit merit: 70 + 10 (1.9× reserve) + 0 (spend >> baseline) = 80 → LOW.
     * Guard: $2,300 < 5 × $500 = $2,500 (no velocity) but MCC 6011 and $2,300 >
     * $2,000 → HIGH cash-out leak. Demonstrates guard fires on threshold, not score.
     */
    {
      tenantId: 'NEO_NATIVE_SECURED',
      accountId: 'SEC_NATIVE_019',
      amount: 230_000, // $2,300.00 — below $2,500 velocity ceiling
      merchantCategoryCode: 6011, // ATM cash advance
      timestamp: new Date('2026-06-11T20:48:09Z').toISOString(),
      historicalMetrics: {
        averageDailySpend: 50_000, // $500.00 — velocity ceiling = $2,500
        consecutiveRentPayments: 0,
        cashReserveRatio: 1.9,
      },
    },

    /**
     * Profile T — Premium secured, in-pattern spend.
     * Pool: NEO_NATIVE_SECURED → TRADITIONAL_SECURED_V1
     * Expected: 70 + 15 (≥ 3.0×) + 5 ($370 < $250 × 1.5 = $375) = 90 → LOW.
     * Anomaly: none.
     */
    {
      tenantId: 'NEO_NATIVE_SECURED',
      accountId: 'SEC_NATIVE_020',
      amount: 37_000, // $370.00 — just within 1.5× baseline, earns spend-stability bonus
      merchantCategoryCode: 5311, // Department stores
      timestamp: new Date('2026-06-11T21:32:55Z').toISOString(),
      historicalMetrics: {
        averageDailySpend: 25_000, // $250.00
        consecutiveRentPayments: 0,
        cashReserveRatio: 3.5,
      },
    },
  ];

  /**
   * Streams each profile asynchronously, simulating real-time ingestion latency.
   *
   * In production this generator would wrap a broker consumer with backpressure,
   * retry, and schema validation; the orchestrator's consumption loop is
   * unchanged regardless of the underlying source.
   *
   * @yields Each {@link CreditTelemetry} event in turn.
   */
  public async *stream(): AsyncGenerator<CreditTelemetry> {
    for (const profile of this.profiles) {
      // Simulate network I/O latency characteristic of a streaming source.
      await new Promise((resolve) => setTimeout(resolve, 25));
      yield profile;
    }
  }
}
