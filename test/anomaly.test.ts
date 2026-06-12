/**
 * @fileoverview Behavioral specs for the securitization guard (anomaly) engine.
 *
 * Covers: the velocity (bust-out) rule and its strict threshold, the cash-out
 * leak rule across both MCCs and its strict threshold, MCC selectivity, rule
 * precedence (CRITICAL supersedes HIGH), and flag metadata.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecuritizationGuardEngine } from '../src/engines/anomalyDetector.js';
import { makeTelemetry } from './helpers.js';

const guard = new SecuritizationGuardEngine();

test('velocity: a transaction above 5x average daily spend is flagged CRITICAL', () => {
  const flag = guard.detect(makeTelemetry({ amount: 600, averageDailySpend: 100 }));

  assert.ok(flag);
  assert.equal(flag.riskLevel, 'CRITICAL');
  assert.equal(flag.ruleId, 'VELOCITY_BUST_OUT');
});

test('velocity: exactly 5x average daily spend does NOT fire (strict threshold)', () => {
  const flag = guard.detect(makeTelemetry({ amount: 500, averageDailySpend: 100 }));
  assert.equal(flag, null);
});

test('velocity: one cent above 5x fires', () => {
  const flag = guard.detect(makeTelemetry({ amount: 501, averageDailySpend: 100 }));
  assert.ok(flag);
  assert.equal(flag.riskLevel, 'CRITICAL');
});

test('cash-out: ATM (MCC 6011) above $2,000 is flagged HIGH', () => {
  const flag = guard.detect(
    makeTelemetry({ merchantCategoryCode: 6011, amount: 200_001, averageDailySpend: 100_000 }),
  );

  assert.ok(flag);
  assert.equal(flag.riskLevel, 'HIGH');
  assert.equal(flag.ruleId, 'CASH_OUT_LEAK');
});

test('cash-out: quasi-cash / crypto (MCC 6051) above $2,000 is flagged HIGH', () => {
  const flag = guard.detect(
    makeTelemetry({ merchantCategoryCode: 6051, amount: 250_000, averageDailySpend: 100_000 }),
  );

  assert.ok(flag);
  assert.equal(flag.riskLevel, 'HIGH');
  assert.equal(flag.ruleId, 'CASH_OUT_LEAK');
});

test('cash-out: exactly $2,000 does NOT fire (strict threshold)', () => {
  const flag = guard.detect(
    makeTelemetry({ merchantCategoryCode: 6011, amount: 200_000, averageDailySpend: 100_000 }),
  );
  assert.equal(flag, null);
});

test('cash-out: a non-cash MCC above $2,000 does NOT fire', () => {
  const flag = guard.detect(
    makeTelemetry({ merchantCategoryCode: 5411, amount: 250_000, averageDailySpend: 100_000 }),
  );
  assert.equal(flag, null);
});

test('precedence: velocity (CRITICAL) supersedes cash-out (HIGH) when both apply', () => {
  const flag = guard.detect(
    makeTelemetry({ merchantCategoryCode: 6011, amount: 600_000, averageDailySpend: 100 }),
  );

  assert.ok(flag);
  assert.equal(flag.riskLevel, 'CRITICAL');
  assert.equal(flag.ruleId, 'VELOCITY_BUST_OUT');
});

test('a benign transaction produces no flag', () => {
  const flag = guard.detect(makeTelemetry({ amount: 10_000, averageDailySpend: 10_000 }));
  assert.equal(flag, null);
});

test('a raised flag carries tenant, account, and a timestamp', () => {
  const flag = guard.detect(
    makeTelemetry({ tenantId: 'TIMS_MIGRATION_POOL', accountId: 'ACCT_X', amount: 600, averageDailySpend: 100 }),
  );

  assert.ok(flag);
  assert.equal(flag.tenantId, 'TIMS_MIGRATION_POOL');
  assert.equal(flag.accountId, 'ACCT_X');
  assert.ok(!Number.isNaN(Date.parse(flag.flaggedAt)));
});
