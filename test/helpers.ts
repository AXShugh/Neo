/**
 * @fileoverview Shared test fixtures and builders.
 *
 * Provides a single source of truth for constructing valid {@link CreditTelemetry}
 * with targeted overrides, and for assembling a fully wired underwriting engine.
 * Centralizing these keeps individual specs focused on behavior rather than setup.
 */

import { UnderwritingEngine } from '../src/engines/underwritingModel.js';
import { AlternativeUnderwritingStrategy } from '../src/strategies/alternativeTrack.js';
import { TraditionalUnderwritingStrategy } from '../src/strategies/traditionalTrack.js';
import type { CreditTelemetry } from '../src/types/index.js';

/** Optional, flattened overrides for {@link makeTelemetry}. */
export interface TelemetryOverrides {
  tenantId?: string;
  accountId?: string;
  amount?: number;
  merchantCategoryCode?: number;
  timestamp?: string;
  averageDailySpend?: number;
  consecutiveRentPayments?: number;
  cashReserveRatio?: number;
}

/**
 * Builds a valid telemetry event with sensible, anomaly-free defaults.
 *
 * Defaults deliberately trip no anomaly rule (amount equals baseline, benign MCC),
 * so a spec only needs to set the fields relevant to the behavior under test.
 *
 * @param overrides - Fields to override on the default event.
 * @returns A fully populated {@link CreditTelemetry}.
 */
export function makeTelemetry(overrides: TelemetryOverrides = {}): CreditTelemetry {
  return {
    tenantId: overrides.tenantId ?? 'TIMS_MIGRATION_POOL',
    accountId: overrides.accountId ?? 'TEST_ACCT',
    amount: overrides.amount ?? 10_000,
    merchantCategoryCode: overrides.merchantCategoryCode ?? 5411,
    timestamp: overrides.timestamp ?? '2026-06-11T00:00:00.000Z',
    historicalMetrics: {
      averageDailySpend: overrides.averageDailySpend ?? 10_000,
      consecutiveRentPayments: overrides.consecutiveRentPayments ?? 0,
      cashReserveRatio: overrides.cashReserveRatio ?? 1.5,
    },
  };
}

/**
 * Assembles an underwriting engine wired with both production strategies,
 * defaulting unknown pools to the conservative alternative-data track.
 *
 * @returns A ready-to-use {@link UnderwritingEngine}.
 */
export function buildUnderwriter(): UnderwritingEngine {
  const alternative = new AlternativeUnderwritingStrategy();
  const traditional = new TraditionalUnderwritingStrategy();
  return new UnderwritingEngine([alternative, traditional], alternative);
}
