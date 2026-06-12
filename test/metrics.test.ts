/**
 * @fileoverview Specs for the pipeline metrics accumulator.
 *
 * Verifies tier and anomaly aggregation, approval/decline rate computation, and
 * the alternative-data inclusion count (which must exclude declined TIMS events).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PipelineMetrics } from '../src/observability/metrics.js';
import { SecuritizationGuardEngine } from '../src/engines/anomalyDetector.js';
import { buildUnderwriter, makeTelemetry } from './helpers.js';

test('metrics aggregate tiers, anomalies, rates, and alternative inclusions', () => {
  const engine = buildUnderwriter();
  const guard = new SecuritizationGuardEngine();
  const metrics = new PipelineMetrics();

  const events = [
    // TIMS, approved (LOW) → counts as an alternative-data inclusion.
    makeTelemetry({ tenantId: 'TIMS_MIGRATION_POOL', accountId: 'm1', consecutiveRentPayments: 24, cashReserveRatio: 4.5 }),
    // Neo-native secured, approved (LOW) → not an alternative inclusion.
    makeTelemetry({ tenantId: 'NEO_NATIVE_SECURED', accountId: 'm2', amount: 8_500, averageDailySpend: 8_500, cashReserveRatio: 1.8 }),
    // TIMS, declined + CRITICAL → must NOT count as an inclusion.
    makeTelemetry({ tenantId: 'TIMS_MIGRATION_POOL', accountId: 'm3', amount: 450_000, averageDailySpend: 56_250, consecutiveRentPayments: 12, cashReserveRatio: 0.8 }),
  ];

  for (const event of events) {
    metrics.record(engine.evaluate(event), guard.detect(event));
  }

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.totalProcessed, 3);
  assert.equal(snapshot.tierDistribution.LOW, 2);
  assert.equal(snapshot.tierDistribution.DECLINE, 1);
  assert.equal(snapshot.anomalyDistribution.CRITICAL, 1);
  assert.equal(snapshot.totalAnomalies, 1);
  assert.equal(snapshot.alternativeInclusionCount, 1);
  assert.equal(snapshot.approvalRatePct, 66.7);
  assert.equal(snapshot.declineRatePct, 33.3);
  assert.equal(snapshot.criticalFlagRatePct, 33.3);
});
