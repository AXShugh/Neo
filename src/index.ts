/**
 * @fileoverview Primary orchestration engine for the Neo Risk Underwriting Pipeline.
 *
 * Composes the pipeline from its independently testable parts and drives the
 * end-to-end flow:
 *  1. Wire pool-specific underwriting strategies into the routing engine
 *     (dependency injection at the composition root).
 *  2. Stream telemetry from the ingestion layer.
 *  3. For each event, underwrite and screen for anomalies in parallel — the two
 *     layers are independent and answer different questions.
 *  4. Commit every decision to the tamper-evident audit ledger and the metrics
 *     accumulator.
 *  5. Emit a structured execution log, a portfolio KPI summary, and a live
 *     verification of the audit trail's integrity.
 */

import { TelemetryStreamer } from './ingestion/telemetryStreamer.js';
import { UnderwritingEngine } from './engines/underwritingModel.js';
import { SecuritizationGuardEngine } from './engines/anomalyDetector.js';
import { AlternativeUnderwritingStrategy } from './strategies/alternativeTrack.js';
import { TraditionalUnderwritingStrategy } from './strategies/traditionalTrack.js';
import { ModelBackedUnderwritingStrategy } from './strategies/modelBackedTrack.js';
import { DecisionLedger } from './audit/decisionLedger.js';
import { PipelineMetrics } from './observability/metrics.js';
import { writeDashboard } from './reporting/htmlReporter.js';
import type { PipelineReportRow } from './reporting/htmlReporter.js';
import type { CreditTelemetry, UnderwritingResult, AnomalyFlag } from './types/index.js';

/** Output path for the generated static dashboard (GitHub Pages serves `/docs`). */
const DASHBOARD_PATH = 'docs/index.html';

/** Renders an integer USD-cents amount as a dollar string. */
function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Prints a boxed section header for visual hierarchy in the execution log. */
function printBanner(lines: readonly string[]): void {
  const width = 67;
  const top = `┌${'─'.repeat(width)}┐`;
  const bottom = `└${'─'.repeat(width)}┘`;
  console.log(top);
  for (const line of lines) {
    const padded = line.padEnd(width - 2, ' ');
    console.log(`│ ${padded} │`);
  }
  console.log(bottom);
}

/** Emits the ingestion view of an incoming telemetry event. */
function logIngestion(telemetry: CreditTelemetry): void {
  const m = telemetry.historicalMetrics;
  console.log(`\n[INGESTION] ${telemetry.accountId}  ·  pool: ${telemetry.tenantId}`);
  console.log(`            amount: ${usd(telemetry.amount)}  ·  MCC: ${telemetry.merchantCategoryCode}`);
  console.log(
    `            baseline/day: ${usd(m.averageDailySpend)}  ·  ` +
      `rent: ${m.consecutiveRentPayments}mo  ·  reserves: ${m.cashReserveRatio.toFixed(1)}x`,
  );
}

/** Emits the underwriting decision, including adverse-action disclosure. */
function logUnderwriting(result: UnderwritingResult): void {
  console.log(
    `[UNDERWRITE] track: ${result.underwritingTrack}  ·  ` +
      `score: ${result.neoRiskScore}  ·  tier: ${result.riskTier}  ·  ${result.decisionId}`,
  );

  const approved = result.riskTier === 'LOW' || result.riskTier === 'MEDIUM';
  if (approved && result.tenantId === 'TIMS_MIGRATION_POOL') {
    console.log('             ✓ ALTERNATIVE-DATA APPROVAL — thin-file applicant admitted via behavioral underwriting');
  } else if (approved) {
    console.log('             ✓ APPROVED — meets pool credit-quality threshold');
  } else if (result.riskTier === 'HIGH') {
    console.log('             ⚠ SUBPRIME — conditional; elevated reserve requirement');
  } else {
    console.log('             ✗ DECLINE — fails minimum credit-quality threshold');
  }

  if (result.adverseActionReasons.length > 0) {
    console.log('             Adverse-action reasons:');
    for (const reason of result.adverseActionReasons) {
      console.log(`               • ${reason}`);
    }
  }
}

/** Emits the anomaly screening outcome for an event. */
function logAnomaly(anomaly: AnomalyFlag | null): void {
  if (!anomaly) {
    console.log('[GUARD]      ✓ clean — no securitization-protection rule triggered');
    return;
  }
  const marker = anomaly.riskLevel === 'CRITICAL' ? '🚨 CRITICAL' : '⚠️  HIGH';
  console.log(`[GUARD]      ${marker}  ·  rule: ${anomaly.ruleId}`);
  console.log(`             ${anomaly.reason}`);
}

/**
 * Runs the complete pipeline end to end.
 *
 * @returns A promise that resolves when the run and reporting are complete.
 */
async function main(): Promise<void> {
  // --- Composition root: assemble the pipeline from its parts ----------------
  const streamer = new TelemetryStreamer();
  const alternativeStrategy = new AlternativeUnderwritingStrategy();
  const traditionalStrategy = new TraditionalUnderwritingStrategy();
  // Registered but not exercised by current profiles — demonstrates that the engine
  // routes to an ML-backed strategy without modification the moment ML_SCORED_POOL
  // events arrive, with no changes to the orchestrator, ledger, or disclosure layer.
  const mlStrategy = new ModelBackedUnderwritingStrategy();
  const underwriter = new UnderwritingEngine(
    [alternativeStrategy, traditionalStrategy, mlStrategy],
    // Unknown pools fail closed onto the conservative alternative-data track.
    alternativeStrategy,
  );
  const guard = new SecuritizationGuardEngine();
  const ledger = new DecisionLedger();
  const metrics = new PipelineMetrics();
  const rows: PipelineReportRow[] = [];

  printBanner([
    '',
    'NEO RISK UNDERWRITING PIPELINE  v2.0',
    'Pool-Aware Underwriting · Securitization Guard · Audit Ledger',
    '',
  ]);

  // --- Stream and process ----------------------------------------------------
  for await (const telemetry of streamer.stream()) {
    const decision = underwriter.evaluate(telemetry);
    const anomaly = guard.detect(telemetry);

    ledger.record(decision, anomaly);
    metrics.record(decision, anomaly);
    rows.push({ telemetry, decision, anomaly });

    logIngestion(telemetry);
    logUnderwriting(decision);
    logAnomaly(anomaly);
  }

  // --- Portfolio KPI summary -------------------------------------------------
  const kpi = metrics.snapshot();
  console.log('');
  printBanner(['', 'PORTFOLIO / SECURITIZATION POOL HEALTH', '']);
  console.log(`  Events processed ............ ${kpi.totalProcessed}`);
  console.log(
    `  Tier distribution ........... LOW ${kpi.tierDistribution.LOW} · ` +
      `MEDIUM ${kpi.tierDistribution.MEDIUM} · HIGH ${kpi.tierDistribution.HIGH} · ` +
      `DECLINE ${kpi.tierDistribution.DECLINE}`,
  );
  console.log('  Track distribution:');
  for (const [track, count] of Object.entries(kpi.trackDistribution)) {
    console.log(`      ${track} ... ${count}`);
  }
  console.log(`  Approval rate ............... ${kpi.approvalRatePct}%`);
  console.log(`  Decline rate ................ ${kpi.declineRatePct}%`);
  console.log(
    `  Anomaly flags ............... ${kpi.totalAnomalies} ` +
      `(CRITICAL ${kpi.anomalyDistribution.CRITICAL} · HIGH ${kpi.anomalyDistribution.HIGH})`,
  );
  console.log(`  Critical flag rate .......... ${kpi.criticalFlagRatePct}%`);
  console.log(`  Alternative-data inclusions . ${kpi.alternativeInclusionCount} thin-file applicant(s) admitted`);

  // --- Audit trail integrity verification ------------------------------------
  const integrity = ledger.verifyIntegrity();
  console.log('');
  printBanner(['', 'AUDIT TRAIL — TAMPER-EVIDENT LEDGER', '']);
  console.log(`  Committed entries ........... ${ledger.getEntries().length}`);
  if (integrity.valid) {
    console.log('  Hash-chain integrity ........ ✓ VERIFIED — chain unbroken, no entry altered');
  } else {
    console.log(`  Hash-chain integrity ........ ✗ BROKEN at sequence ${integrity.brokenAtSequence}`);
  }

  // --- Static dashboard generation -------------------------------------------
  const dashboardPath = await writeDashboard(
    {
      generatedAt: new Date().toISOString(),
      rows,
      kpi,
      ledgerEntries: ledger.getEntries(),
      integrity,
    },
    DASHBOARD_PATH,
  );
  console.log('');
  printBanner(['', 'DASHBOARD', '']);
  console.log(`  Static dashboard written .... ${dashboardPath}`);
  console.log('  View ........................ open the file in a browser, or host /docs on GitHub Pages');

  console.log('\n✅ Pipeline execution completed successfully.\n');
}

main().catch((error: unknown) => {
  console.error('Pipeline execution failed:', error);
  process.exit(1);
});
