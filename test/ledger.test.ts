/**
 * @fileoverview Specs for the tamper-evident decision ledger.
 *
 * Verifies the chain links to genesis, that successive entries are hash-linked,
 * that an intact chain verifies, and — critically — that any retroactive mutation
 * of a committed entry is detected at the correct position.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DecisionLedger } from '../src/audit/decisionLedger.js';
import { buildUnderwriter, makeTelemetry } from './helpers.js';

const GENESIS_HASH = '0'.repeat(64);

/** Seeds a ledger with three distinct, recorded decisions. */
function seedLedger(): DecisionLedger {
  const engine = buildUnderwriter();
  const ledger = new DecisionLedger();
  const events = [
    makeTelemetry({ accountId: 'L1', consecutiveRentPayments: 24, cashReserveRatio: 4.5 }),
    makeTelemetry({ accountId: 'L2', tenantId: 'NEO_NATIVE_SECURED', amount: 8_500, averageDailySpend: 8_500, cashReserveRatio: 1.8 }),
    makeTelemetry({ accountId: 'L3', consecutiveRentPayments: 0, cashReserveRatio: 0.5 }),
  ];
  for (const event of events) {
    ledger.record(engine.evaluate(event), null);
  }
  return ledger;
}

test('an untampered ledger verifies as intact', () => {
  const report = seedLedger().verifyIntegrity();
  assert.equal(report.valid, true);
  assert.equal(report.brokenAtSequence, null);
});

test('the first entry anchors to genesis and every entry links to its predecessor', () => {
  const entries = seedLedger().getEntries();
  assert.ok(entries.length >= 2);
  assert.equal(entries[0]?.previousHash, GENESIS_HASH);

  for (let i = 1; i < entries.length; i += 1) {
    assert.equal(entries[i]?.previousHash, entries[i - 1]?.entryHash);
  }
});

test('retroactively mutating a committed entry breaks the chain at that position', () => {
  const ledger = seedLedger();
  const entries = ledger.getEntries();

  // Simulate after-the-fact falsification of the second decision's score.
  const target = entries[1];
  assert.ok(target);
  target.neoRiskScore = 999;

  const report = ledger.verifyIntegrity();
  assert.equal(report.valid, false);
  assert.equal(report.brokenAtSequence, 2);
});
