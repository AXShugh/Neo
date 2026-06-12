/**
 * @fileoverview Behavioral specs for the pool-aware underwriting engine.
 *
 * Covers: per-track scoring math, pool-based routing, the conservative default
 * fallback, exclusive-boundary correctness, tier classification boundaries,
 * adverse-action reason derivation, and deterministic decision identifiers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUnderwriter, makeTelemetry } from './helpers.js';

test('alternative track: 24mo rent + 4.5x reserves scores 100 / LOW with no adverse reasons', () => {
  const result = buildUnderwriter().evaluate(
    makeTelemetry({
      tenantId: 'TIMS_MIGRATION_POOL',
      consecutiveRentPayments: 24,
      cashReserveRatio: 4.5,
    }),
  );

  assert.equal(result.underwritingTrack, 'ALTERNATIVE_DATA_V1');
  assert.equal(result.neoRiskScore, 100);
  assert.equal(result.riskTier, 'LOW');
  assert.deepEqual(result.adverseActionReasons, []);
});

test('alternative track: moderate rent (13mo) + adequate reserves scores 75 / MEDIUM', () => {
  const result = buildUnderwriter().evaluate(
    makeTelemetry({
      tenantId: 'TIMS_MIGRATION_POOL',
      consecutiveRentPayments: 13,
      cashReserveRatio: 1.5,
    }),
  );

  assert.equal(result.neoRiskScore, 75);
  assert.equal(result.riskTier, 'MEDIUM');
  assert.deepEqual(result.adverseActionReasons, []);
});

test('alternative track: deficient reserves + 12mo rent scores 30 / DECLINE with reason codes', () => {
  const result = buildUnderwriter().evaluate(
    makeTelemetry({
      tenantId: 'TIMS_MIGRATION_POOL',
      consecutiveRentPayments: 12,
      cashReserveRatio: 0.8,
    }),
  );

  assert.equal(result.neoRiskScore, 30);
  assert.equal(result.riskTier, 'DECLINE');
  assert.ok(result.factors.some((f) => f.code === 'CASH_RESERVE_DEFICIENT'));
  assert.ok(result.adverseActionReasons.length >= 1);
  // The most score-suppressing factor (reserve penalty) must lead the disclosure.
  assert.match(result.adverseActionReasons[0] ?? '', /reserve/i);
});

test('alternative track: exclusive boundaries (rent = 12, reserve = 1.0) grant neither bonus nor penalty', () => {
  const result = buildUnderwriter().evaluate(
    makeTelemetry({
      tenantId: 'TIMS_MIGRATION_POOL',
      consecutiveRentPayments: 12,
      cashReserveRatio: 1.0,
    }),
  );

  assert.equal(result.neoRiskScore, 50);
  assert.equal(result.riskTier, 'HIGH');
  assert.ok(result.factors.some((f) => f.code === 'RENT_HISTORY_INSUFFICIENT'));
  assert.ok(result.factors.some((f) => f.code === 'CASH_RESERVE_ADEQUATE'));
  assert.equal(result.adverseActionReasons.length, 2);
});

test('traditional track: standard secured borrower scores 85 / LOW', () => {
  const result = buildUnderwriter().evaluate(
    makeTelemetry({
      tenantId: 'NEO_NATIVE_SECURED',
      amount: 8_500,
      averageDailySpend: 8_500,
      consecutiveRentPayments: 0,
      cashReserveRatio: 1.8,
    }),
  );

  assert.equal(result.underwritingTrack, 'TRADITIONAL_SECURED_V1');
  assert.equal(result.neoRiskScore, 85);
  assert.equal(result.riskTier, 'LOW');
  assert.deepEqual(result.adverseActionReasons, []);
});

test('traditional track: deficient reserves drop a secured borrower to HIGH with reason codes', () => {
  const result = buildUnderwriter().evaluate(
    makeTelemetry({
      tenantId: 'NEO_NATIVE_SECURED',
      amount: 5_000,
      averageDailySpend: 5_000,
      cashReserveRatio: 0.5,
    }),
  );

  // 70 base − 20 deficient + 5 stable = 55 → HIGH
  assert.equal(result.neoRiskScore, 55);
  assert.equal(result.riskTier, 'HIGH');
  assert.ok(result.adverseActionReasons.some((r) => /reserve/i.test(r)));
});

test('tier classification: a score of exactly 80 is LOW (inclusive lower bound)', () => {
  const result = buildUnderwriter().evaluate(
    makeTelemetry({
      tenantId: 'NEO_NATIVE_SECURED',
      amount: 30_000, // 3x baseline → spend elevated, no stability bonus
      averageDailySpend: 10_000,
      cashReserveRatio: 2.0, // adequate band → +10
    }),
  );

  // 70 base + 10 adequate + 0 elevated = 80 → LOW
  assert.equal(result.neoRiskScore, 80);
  assert.equal(result.riskTier, 'LOW');
});

test('routing: tenant selects the correct strategy track', () => {
  const engine = buildUnderwriter();

  const tims = engine.evaluate(makeTelemetry({ tenantId: 'TIMS_MIGRATION_POOL' }));
  const neo = engine.evaluate(makeTelemetry({ tenantId: 'NEO_NATIVE_SECURED' }));

  assert.equal(tims.underwritingTrack, 'ALTERNATIVE_DATA_V1');
  assert.equal(neo.underwritingTrack, 'TRADITIONAL_SECURED_V1');
});

test('routing: an unknown pool fails closed onto the conservative default track', () => {
  const result = buildUnderwriter().evaluate(
    makeTelemetry({ tenantId: 'UNREGISTERED_POOL_XYZ' }),
  );

  assert.equal(result.underwritingTrack, 'ALTERNATIVE_DATA_V1');
});

test('decision identifiers are deterministic and content-derived', () => {
  const engine = buildUnderwriter();
  const telemetry = makeTelemetry({
    tenantId: 'TIMS_MIGRATION_POOL',
    accountId: 'IDEMPOTENT_001',
    consecutiveRentPayments: 24,
    cashReserveRatio: 4.5,
  });

  const first = engine.evaluate(telemetry);
  const second = engine.evaluate(telemetry);

  assert.match(first.decisionId, /^DEC-[0-9A-F]{12}$/);
  assert.equal(first.decisionId, second.decisionId);
});

test('approvals never carry adverse-action reasons; non-approvals always do', () => {
  const engine = buildUnderwriter();

  const approved = engine.evaluate(
    makeTelemetry({ tenantId: 'TIMS_MIGRATION_POOL', consecutiveRentPayments: 24, cashReserveRatio: 4.5 }),
  );
  const declined = engine.evaluate(
    makeTelemetry({ tenantId: 'TIMS_MIGRATION_POOL', consecutiveRentPayments: 0, cashReserveRatio: 0.5 }),
  );

  assert.equal(approved.adverseActionReasons.length, 0);
  assert.ok(declined.adverseActionReasons.length > 0);
});
