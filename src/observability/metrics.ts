/**
 * @fileoverview Pipeline observability and pool-health metrics.
 *
 * Aggregates the stream of decisions and anomalies into the portfolio-level key
 * performance indicators a risk owner monitors to assess securitized-pool health:
 * tier and track distribution, approval/decline rates, fraud-flag rate, and the
 * alternative-data financial-inclusion count (thin-file applicants responsibly
 * admitted). These are the signals that, in production, would feed dashboards,
 * SLOs, and model-drift alerting.
 *
 * The collector is intentionally a pure in-memory accumulator with an immutable
 * snapshot, decoupled from any particular metrics backend (StatsD, Prometheus,
 * OpenTelemetry) so the transport can be swapped without touching the pipeline.
 */

import type {
  UnderwritingResult,
  AnomalyFlag,
  RiskTier,
  AnomalyRiskLevel,
} from '../types/index.js';

/** Tenant pool whose non-declined decisions count as alternative-data inclusions. */
const ALTERNATIVE_INCLUSION_TENANT = 'TIMS_MIGRATION_POOL';

/**
 * An immutable point-in-time view of pipeline KPIs.
 *
 * @interface PipelineKpiSnapshot
 */
export interface PipelineKpiSnapshot {
  /** Total telemetry events evaluated. */
  totalProcessed: number;
  /** Count of decisions per risk tier. */
  tierDistribution: Record<RiskTier, number>;
  /** Count of decisions per underwriting track. */
  trackDistribution: Record<string, number>;
  /** Count of anomaly flags per severity level. */
  anomalyDistribution: Record<AnomalyRiskLevel, number>;
  /** Total anomaly flags raised. */
  totalAnomalies: number;
  /** Percentage of decisions that were not declined. */
  approvalRatePct: number;
  /** Percentage of decisions that were declined. */
  declineRatePct: number;
  /** Percentage of events that raised a CRITICAL anomaly flag. */
  criticalFlagRatePct: number;
  /** Count of thin-file (TIMS pool) applicants approved via alternative data. */
  alternativeInclusionCount: number;
}

/**
 * In-memory accumulator producing {@link PipelineKpiSnapshot} views.
 *
 * @class PipelineMetrics
 */
export class PipelineMetrics {
  private total = 0;
  private readonly tierCounts: Record<RiskTier, number> = {
    LOW: 0,
    MEDIUM: 0,
    HIGH: 0,
    DECLINE: 0,
  };
  private readonly anomalyCounts: Record<AnomalyRiskLevel, number> = {
    HIGH: 0,
    CRITICAL: 0,
  };
  private readonly trackCounts = new Map<string, number>();
  private alternativeInclusionCount = 0;

  /**
   * Records a single evaluated event into the running aggregates.
   *
   * @param result - The underwriting decision for the event.
   * @param anomaly - The anomaly flag for the same event, or `null`.
   */
  public record(result: UnderwritingResult, anomaly: AnomalyFlag | null): void {
    this.total += 1;
    this.tierCounts[result.riskTier] += 1;
    this.trackCounts.set(
      result.underwritingTrack,
      (this.trackCounts.get(result.underwritingTrack) ?? 0) + 1,
    );

    if (result.tenantId === ALTERNATIVE_INCLUSION_TENANT && result.riskTier !== 'DECLINE') {
      this.alternativeInclusionCount += 1;
    }

    if (anomaly) {
      this.anomalyCounts[anomaly.riskLevel] += 1;
    }
  }

  /**
   * Produces an immutable snapshot of the current KPIs.
   *
   * @returns The aggregated {@link PipelineKpiSnapshot}.
   */
  public snapshot(): PipelineKpiSnapshot {
    const declines = this.tierCounts.DECLINE;
    const totalAnomalies = this.anomalyCounts.HIGH + this.anomalyCounts.CRITICAL;

    return {
      totalProcessed: this.total,
      tierDistribution: { ...this.tierCounts },
      trackDistribution: Object.fromEntries(this.trackCounts),
      anomalyDistribution: { ...this.anomalyCounts },
      totalAnomalies,
      approvalRatePct: this.percentage(this.total - declines),
      declineRatePct: this.percentage(declines),
      criticalFlagRatePct: this.percentage(this.anomalyCounts.CRITICAL),
      alternativeInclusionCount: this.alternativeInclusionCount,
    };
  }

  /**
   * Computes a value as a one-decimal percentage of the total processed.
   *
   * @param value - The numerator.
   * @returns The percentage, or 0 when nothing has been processed.
   */
  private percentage(value: number): number {
    if (this.total === 0) return 0;
    return Number(((value / this.total) * 100).toFixed(1));
  }
}
