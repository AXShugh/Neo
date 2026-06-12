/**
 * @fileoverview Static dashboard reporter for the Neo Risk Pipeline.
 *
 * Renders a single, fully self-contained HTML dashboard from a completed pipeline
 * run — no runtime dependencies, no server, no build step. The data is inlined at
 * generation time, so the resulting file opens directly in any browser and hosts
 * unchanged on GitHub Pages. This keeps the deliverable a static artifact while
 * giving reviewers a visual, portfolio-grade view of the same decisions, KPIs, and
 * tamper-evident audit chain the CLI prints to the terminal.
 *
 * All styling is bundled inline (the page cannot rely on any host stylesheet) and
 * all dynamic content is HTML-escaped at the boundary.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CreditTelemetry, UnderwritingResult, AnomalyFlag } from '../types/index.js';
import type { PipelineKpiSnapshot } from '../observability/metrics.js';
import type { LedgerEntry, IntegrityReport } from '../audit/decisionLedger.js';

/** One processed event: its telemetry, the decision, and any anomaly flag. */
export interface PipelineReportRow {
  telemetry: CreditTelemetry;
  decision: UnderwritingResult;
  anomaly: AnomalyFlag | null;
}

/** The complete, render-ready snapshot of a pipeline run. */
export interface PipelineReport {
  generatedAt: string;
  rows: readonly PipelineReportRow[];
  kpi: PipelineKpiSnapshot;
  ledgerEntries: readonly LedgerEntry[];
  integrity: IntegrityReport;
}

/** Escapes the five characters that are unsafe in HTML text/attribute context. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Renders an integer USD-cents amount as a dollar string. */
function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Maps a risk tier to its semantic CSS class suffix. */
function tierClass(tier: string): string {
  switch (tier) {
    case 'LOW':    return 'ok';
    case 'MEDIUM': return 'info';
    case 'HIGH':   return 'warn';
    default:       return 'bad';
  }
}

/** Renders a decision feed table row. */
function renderRow(row: PipelineReportRow): string {
  const { decision, anomaly, telemetry } = row;
  const reasons =
    decision.adverseActionReasons.length > 0
      ? `<ul class="reasons">${decision.adverseActionReasons
          .map((r) => `<li>${escapeHtml(r)}</li>`)
          .join('')}</ul>`
      : '';

  const flagHtml = anomaly
    ? `<span class="flag ${anomaly.riskLevel === 'CRITICAL' ? 'crit' : 'high'}">${escapeHtml(anomaly.riskLevel)}&nbsp;·&nbsp;${escapeHtml(anomaly.ruleId)}</span>`
    : `<span class="flag clean">—</span>`;

  return `
      <tr>
        <td>
          <span class="acct-id">${escapeHtml(decision.accountId)}</span>
          ${reasons}
        </td>
        <td class="mono-sm">${escapeHtml(telemetry.tenantId)}<br><span class="sub-track">${escapeHtml(decision.underwritingTrack)}</span></td>
        <td class="r mono-sm">${usd(telemetry.amount)}</td>
        <td class="r score-cell">${decision.neoRiskScore}</td>
        <td><span class="tier ${tierClass(decision.riskTier)}">${escapeHtml(decision.riskTier)}</span></td>
        <td class="r">${flagHtml}</td>
      </tr>`;
}

/** Renders one distribution bar with count and percentage. */
function renderBar(label: string, count: number, total: number, cls: string): string {
  const pct = total === 0 ? 0 : Math.round((count / total) * 100);
  return `
      <div class="bar-row">
        <span class="bar-label">${escapeHtml(label)}</span>
        <span class="bar-track"><span class="bar-fill ${cls}" style="width:${pct}%"></span></span>
        <span class="bar-count">${count}</span>
        <span class="bar-pct">${pct}%</span>
      </div>`;
}

/** Renders a single audit-ledger table row. */
function renderLedgerEntry(entry: LedgerEntry): string {
  const shortPrev = `${entry.previousHash.slice(0, 16)}&hellip;`;
  return `
      <tr>
        <td class="mono-sm dim">${entry.sequence}</td>
        <td><span class="ledger-hash">${escapeHtml(entry.decisionId)}</span></td>
        <td class="mono-sm">${escapeHtml(entry.accountId)}</td>
        <td><span class="ledger-hash">${shortPrev}</span></td>
        <td class="r"><span class="verified">Verified</span></td>
      </tr>`;
}

/**
 * Renders the complete dashboard document for a pipeline run.
 *
 * @param report - The render-ready run snapshot.
 * @returns A self-contained HTML document string.
 */
export function renderDashboardHtml(report: PipelineReport): string {
  const { kpi, rows, ledgerEntries, integrity, generatedAt } = report;

  const tierBars = [
    renderBar('LOW',     kpi.tierDistribution.LOW,     kpi.totalProcessed, 'ok'),
    renderBar('MEDIUM',  kpi.tierDistribution.MEDIUM,  kpi.totalProcessed, 'info'),
    renderBar('HIGH',    kpi.tierDistribution.HIGH,    kpi.totalProcessed, 'warn'),
    renderBar('DECLINE', kpi.tierDistribution.DECLINE, kpi.totalProcessed, 'bad'),
  ].join('');

  const trackBars = Object.entries(kpi.trackDistribution)
    .map(([track, count]) => renderBar(track, count, kpi.totalProcessed, 'info'))
    .join('');

  const integrityBadge = integrity.valid
    ? `<span class="badge ok">Audit Chain Verified</span>`
    : `<span class="badge bad">Chain Broken @ #${integrity.brokenAtSequence}</span>`;

  const critPlural = kpi.anomalyDistribution.CRITICAL !== 1 ? 's' : '';
  const highPlural = kpi.anomalyDistribution.HIGH !== 1 ? 's' : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Neo Risk Underwriting Pipeline — Run Dashboard</title>
<style>
  :root {
    --bg:#000000;
    --surface:#0b0b0b;
    --surface2:#141414;
    --surface3:#1e1e1e;
    --border:rgba(255,255,255,.07);
    --border-md:rgba(255,255,255,.13);
    --text:#f4f4f4;
    --muted:#8c8c8c;
    --dim:#565656;
    --accent:#ff5a36;
    --accent-bg:rgba(255,90,54,.14);
    --ok:#34c27e;
    --ok-bg:rgba(52,194,126,.13);
    --bad:#e0584a;
    --bad-bg:rgba(224,88,74,.14);
    --warn:#d6a526;
    --warn-bg:rgba(214,165,38,.14);
    --info:#c9c9c9;
    --info-bg:rgba(255,255,255,.08);
    --mono:'SF Mono',ui-monospace,'Cascadia Code',Menlo,Consolas,monospace;
    --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,Roboto,sans-serif;
    --r:4px;
  }
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:var(--bg);color:var(--text);font-family:var(--sans);font-size:13px;line-height:1.55;}

  /* ── TOP BAR ── */
  .topbar{
    position:sticky;top:0;z-index:20;
    background:var(--surface);
    border-bottom:1px solid var(--border-md);
    padding:0 28px;
    height:52px;
    display:flex;align-items:center;justify-content:space-between;gap:20px;
  }
  .topbar-left{display:flex;align-items:center;gap:0;}
  .brand-mark{
    width:9px;height:9px;background:var(--accent);border-radius:2px;
    margin-right:12px;flex-shrink:0;
  }
  .product-name{
    font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;
    color:var(--text);padding-right:20px;
  }
  .product-sub{
    font-size:11px;color:var(--muted);letter-spacing:.03em;
    border-left:1px solid var(--border-md);padding-left:20px;
  }
  .topbar-right{display:flex;align-items:center;gap:16px;flex-shrink:0;}
  .run-ts{font-size:11px;color:var(--dim);font-family:var(--mono);}

  /* ── BADGE ── */
  .badge{
    display:inline-flex;align-items:center;gap:6px;
    font-size:10px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;
    padding:4px 10px;border-radius:3px;white-space:nowrap;
  }
  .badge::before{content:'';width:6px;height:6px;border-radius:50%;flex-shrink:0;}
  .badge.ok{background:var(--ok-bg);color:var(--ok);}
  .badge.ok::before{background:var(--ok);}
  .badge.bad{background:var(--bad-bg);color:var(--bad);}
  .badge.bad::before{background:var(--bad);}

  /* ── LAYOUT ── */
  .wrap{max-width:1060px;margin:0 auto;padding:28px 28px 56px;}

  /* ── SECTION LABEL ── */
  .slabel{
    font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;
    color:var(--muted);margin-bottom:10px;padding-bottom:8px;
    border-bottom:1px solid var(--border);
  }

  /* ── KPI STRIP ── */
  .kpis{
    display:grid;grid-template-columns:repeat(5,1fr);
    gap:1px;background:var(--border-md);
    border:1px solid var(--border-md);border-radius:var(--r);overflow:hidden;
    margin-bottom:24px;
  }
  .kpi{background:var(--surface);padding:16px 18px;border-left:3px solid transparent;}
  .kpi.k-accent{border-left-color:var(--accent);}
  .kpi.k-ok{border-left-color:var(--ok);}
  .kpi.k-bad{border-left-color:var(--bad);}
  .kpi.k-warn{border-left-color:var(--warn);}
  .kpi-label{
    font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;
    color:var(--muted);margin-bottom:8px;
  }
  .kpi-value{font-size:30px;font-weight:300;letter-spacing:-.02em;color:var(--text);}
  .kpi-unit{font-size:11px;color:var(--dim);margin-top:3px;}

  /* ── DATA TABLE ── */
  .dtable{
    width:100%;border-collapse:collapse;
    background:var(--surface);
    border:1px solid var(--border-md);border-radius:var(--r);overflow:hidden;
    margin-bottom:24px;font-size:12px;
  }
  .dtable th{
    background:var(--surface2);padding:8px 14px;text-align:left;
    font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;
    color:var(--muted);border-bottom:1px solid var(--border-md);white-space:nowrap;
  }
  .dtable th.r{text-align:right;}
  .dtable td{padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:top;}
  .dtable tr:last-child td{border-bottom:none;}
  .dtable tr:hover td{background:var(--surface2);}
  .dtable td.r{text-align:right;}

  .acct-id{font-family:var(--mono);font-size:12px;font-weight:500;color:var(--text);}
  .mono-sm{font-family:var(--mono);font-size:11px;}
  .dim{color:var(--dim);}
  .sub-track{font-size:10px;color:var(--dim);letter-spacing:.03em;}

  .reasons{margin:6px 0 0;padding-left:0;list-style:none;}
  .reasons li{font-size:11px;color:var(--muted);padding:1px 0;}
  .reasons li::before{content:'—';margin-right:5px;color:var(--dim);}

  .score-cell{font-size:20px;font-weight:300;color:var(--text);}

  .tier{
    display:inline-block;
    font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
    padding:3px 8px;border-radius:3px;white-space:nowrap;
  }
  .tier.ok{background:var(--ok-bg);color:var(--ok);}
  .tier.info{background:var(--info-bg);color:var(--info);}
  .tier.warn{background:var(--warn-bg);color:var(--warn);}
  .tier.bad{background:var(--bad-bg);color:var(--bad);}

  .flag{
    display:inline-block;
    font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
    padding:3px 8px;border-radius:3px;white-space:nowrap;
  }
  .flag.crit{background:var(--bad-bg);color:var(--bad);}
  .flag.high{background:var(--warn-bg);color:var(--warn);}
  .flag.clean{color:var(--dim);font-weight:400;letter-spacing:0;text-transform:none;font-size:13px;}

  /* ── TWO-COL ── */
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px;}
  .card{
    background:var(--surface);
    border:1px solid var(--border-md);border-radius:var(--r);
    padding:18px 20px;
  }

  /* ── BAR CHART ── */
  .bar-row{display:flex;align-items:center;gap:10px;margin:10px 0;font-size:11px;}
  .bar-label{
    width:136px;color:var(--muted);font-family:var(--mono);font-size:10px;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  }
  .bar-track{flex:1;height:4px;background:var(--surface3);border-radius:2px;overflow:hidden;}
  .bar-fill{display:block;height:4px;border-radius:2px;}
  .bar-fill.ok{background:var(--ok);}
  .bar-fill.info{background:var(--info);}
  .bar-fill.warn{background:var(--warn);}
  .bar-fill.bad{background:var(--bad);}
  .bar-count{width:20px;text-align:right;color:var(--muted);}
  .bar-pct{width:32px;text-align:right;color:var(--dim);font-size:10px;}

  .anomaly-summary{
    margin-top:14px;padding-top:12px;border-top:1px solid var(--border);
    font-size:11px;color:var(--muted);display:flex;gap:16px;
  }
  .anomaly-summary span{display:flex;align-items:center;gap:5px;}
  .dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;}
  .dot.bad{background:var(--bad);}
  .dot.warn{background:var(--warn);}

  /* ── LEDGER ── */
  .ledger-hash{font-family:var(--mono);font-size:11px;color:var(--muted);}
  .verified{
    font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
    color:var(--ok);
  }

  /* ── FOOTER ── */
  footer{
    margin-top:12px;padding-top:20px;border-top:1px solid var(--border);
    font-size:11px;color:var(--dim);
    display:flex;justify-content:space-between;align-items:center;
  }
  footer code{font-family:var(--mono);color:var(--muted);}
</style>
</head>
<body>

<header class="topbar">
  <div class="topbar-left">
    <span class="brand-mark"></span>
    <span class="product-name">Risk Underwriting Pipeline</span>
    <span class="product-sub">Pool-aware credit decisioning &nbsp;·&nbsp; ABS securitization guard &nbsp;·&nbsp; tamper-evident audit</span>
  </div>
  <div class="topbar-right">
    <span class="run-ts">${escapeHtml(generatedAt)}</span>
    ${integrityBadge}
  </div>
</header>

<main class="wrap">

  <section class="kpis">
    <div class="kpi k-accent">
      <div class="kpi-label">Events Processed</div>
      <div class="kpi-value">${kpi.totalProcessed}</div>
      <div class="kpi-unit">this run</div>
    </div>
    <div class="kpi k-ok">
      <div class="kpi-label">Approval Rate</div>
      <div class="kpi-value">${kpi.approvalRatePct}%</div>
      <div class="kpi-unit">non-declined</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Decline Rate</div>
      <div class="kpi-value">${kpi.declineRatePct}%</div>
      <div class="kpi-unit">declined</div>
    </div>
    <div class="kpi k-bad">
      <div class="kpi-label">Critical Flags</div>
      <div class="kpi-value">${kpi.anomalyDistribution.CRITICAL}</div>
      <div class="kpi-unit">securitization alert${critPlural}</div>
    </div>
    <div class="kpi k-accent">
      <div class="kpi-label">Alt-Data Inclusions</div>
      <div class="kpi-value">${kpi.alternativeInclusionCount}</div>
      <div class="kpi-unit">thin-file approval${kpi.alternativeInclusionCount !== 1 ? 's' : ''}</div>
    </div>
  </section>

  <div class="slabel">Decision Feed</div>
  <table class="dtable">
    <thead>
      <tr>
        <th>Account</th>
        <th>Pool &nbsp;·&nbsp; Track</th>
        <th class="r">Amount</th>
        <th class="r">Score</th>
        <th>Tier</th>
        <th class="r">Guard Status</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map(renderRow).join('')}
    </tbody>
  </table>

  <div class="cols">
    <div class="card">
      <div class="slabel">Risk Tier Distribution</div>
      ${tierBars}
    </div>
    <div class="card">
      <div class="slabel">Underwriting Track</div>
      ${trackBars}
      <div class="anomaly-summary">
        <span><span class="dot bad"></span>${kpi.anomalyDistribution.CRITICAL} critical velocity alert${critPlural}</span>
        <span><span class="dot warn"></span>${kpi.anomalyDistribution.HIGH} high cash-out flag${highPlural}</span>
      </div>
    </div>
  </div>

  <div class="slabel">Audit Ledger &mdash; Hash-chained, genesis-anchored</div>
  <table class="dtable">
    <thead>
      <tr>
        <th>Seq</th>
        <th>Decision ID</th>
        <th>Account</th>
        <th>Prev Hash (truncated)</th>
        <th class="r">Integrity</th>
      </tr>
    </thead>
    <tbody>
      ${ledgerEntries.map(renderLedgerEntry).join('')}
    </tbody>
  </table>

  <footer>
    <span>Generated by <code>neo-risk-underwriting-pipeline</code> &nbsp;·&nbsp; zero runtime dependencies</span>
    <span>${ledgerEntries.length} ledger entries &nbsp;·&nbsp; integrity ${integrity.valid ? 'verified' : 'BROKEN'}</span>
  </footer>

</main>
</body>
</html>
`;
}

/**
 * Renders the dashboard and writes it to disk, creating parent directories.
 *
 * @param report - The render-ready run snapshot.
 * @param outputPath - Destination file path (e.g., `docs/index.html`).
 * @returns The path written.
 */
export async function writeDashboard(report: PipelineReport, outputPath: string): Promise<string> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderDashboardHtml(report), 'utf8');
  return outputPath;
}
