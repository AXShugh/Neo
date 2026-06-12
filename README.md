# Neo Risk Underwriting Pipeline

An enterprise-grade backend data pipeline for **alternative credit underwriting** and **asset-backed securitization (ABS) pool protection**, built in strict TypeScript with **zero runtime dependencies**.

The pipeline ingests real-time credit telemetry, routes each event to the underwriting model appropriate for its tenant pool, screens it for fraud and compliance violations, and commits every decision to a tamper-evident audit ledger — while emitting portfolio-level pool-health metrics.

---

## Why this design

A single scoring function cannot serve structurally different credit products without mislabeling risk. A thin-file migrant and a collateral-backed secured borrower carry different economics and different available signals. This pipeline therefore makes **the tenant pool select the underwriting strategy** (Strategy pattern), which:

- scores a no-FICO applicant on behavioral data (rent discipline, reserves), and
- scores a secured borrower on collateral-adjusted, reserve-and-stability signals,

so each account is judged on the axes that actually apply to it. Three cross-cutting concerns — **explainability** (adverse-action reason codes), **auditability** (a hash-chained decision ledger), and **observability** (pool-health KPIs) — are first-class, not afterthoughts.

---

## Architecture

```
                       ┌────────────────────────────┐
                       │   TelemetryStreamer        │
                       │   async generator stream   │
                       └─────────────┬──────────────┘
                                     │ CreditTelemetry
              ┌──────────────────────┴───────────────────────┐
              ▼                                               ▼
 ┌────────────────────────────┐              ┌────────────────────────────────┐
 │   UnderwritingEngine       │              │  SecuritizationGuardEngine      │
 │   (routes by tenant pool)  │              │  (velocity + cash-out rules)    │
 │                            │              └────────────────┬───────────────┘
 │   ┌──────────────────────┐ │                               │ AnomalyFlag | null
 │   │ AlternativeStrategy  │ │                               │
 │   │ TraditionalStrategy  │ │                               │
 │   └──────────────────────┘ │                               │
 └─────────────┬──────────────┘                               │
               │ UnderwritingResult (+ reason codes)          │
               └──────────────────────┬───────────────────────┘
                                      ▼
                   ┌───────────────────────────────────────┐
                   │  Orchestration (index.ts)             │
                   │   → DecisionLedger  (hash-chained)    │
                   │   → PipelineMetrics (pool KPIs)       │
                   │   → structured execution log          │
                   └───────────────────────────────────────┘
```

### Modules

| Path | Responsibility |
| --- | --- |
| `src/types/index.ts` | Explicit, un-nested domain contracts shared by every layer |
| `src/config/riskParameters.ts` | Single immutable source of all thresholds and weights (no magic numbers) |
| `src/ingestion/telemetryStreamer.ts` | Streams engineered consumer profiles via an async generator |
| `src/features/featureExtractor.ts` | Single source of truth that derives the model-ready `FeatureVector` from raw telemetry (training/serving parity) |
| `src/strategies/underwritingStrategy.ts` | The `UnderwritingStrategy` contract — consumes a `FeatureVector` (Strategy pattern) |
| `src/strategies/alternativeTrack.ts` | Thin-file / no-FICO behavioral scorecard (`TIMS_MIGRATION_POOL`) |
| `src/strategies/traditionalTrack.ts` | Collateral-backed secured scorecard (`NEO_NATIVE_SECURED`) |
| `src/strategies/modelBackedTrack.ts` | Integration **stub** for an external PD model — the model-agnostic seam (see *ML-readiness* below) |
| `src/engines/underwritingModel.ts` | Routes telemetry to a strategy; classifies tier; derives reason codes |
| `src/engines/anomalyDetector.ts` | Deterministic securitization-protection rules |
| `src/audit/decisionLedger.ts` | Append-only, hash-chained, tamper-evident decision ledger |
| `src/observability/metrics.ts` | Portfolio / pool-health KPI accumulator |
| `src/reporting/htmlReporter.ts` | Generates the self-contained static dashboard (`docs/index.html`) |
| `src/index.ts` | Composition root and orchestration |
| `test/*.test.ts` | 25 specs across underwriting, anomaly, ledger, and metrics |

---

## Underwriting strategies

Both tracks are purely additive and fully transparent: every point is emitted as a `ScoringFactor` with a stable code, a description, and a signed contribution. Final tiers are **LOW** (80+) · **MEDIUM** (60–79) · **HIGH** (40–59) · **DECLINE** (<40).

### Alternative-data track — `TIMS_MIGRATION_POOL`

| Signal | Adjustment |
| --- | --- |
| Base (thin-file) | `50` |
| Consecutive rent payments > 20 months | `+35` |
| Consecutive rent payments > 12 months | `+25` |
| Cash reserve ratio ≥ 3.0x | `+15` |
| Cash reserve ratio < 1.0x | `−20` |

### Traditional secured track — `NEO_NATIVE_SECURED`

| Signal | Adjustment |
| --- | --- |
| Base (collateral-backed) | `70` |
| Cash reserve ratio ≥ 3.0x | `+15` |
| Cash reserve ratio ≥ 1.5x | `+10` |
| Cash reserve ratio < 1.0x | `−20` |
| Transaction within 1.5x of baseline spend | `+5` |

> **Routing safety:** telemetry from an unrecognized pool falls back to the conservative alternative-data track — the system fails *closed*, never open.

### Adverse-action reason codes

When an outcome is **HIGH** or **DECLINE**, the engine surfaces the limiting factors (zero/negative contributions, most-suppressing first) as `adverseActionReasons` — the disclosure any consumer-credit adjudication system must provide, rather than reverse-engineering it from an opaque score.

---

## ML-readiness

**There is no trained model in this repository, and the two active tracks are deterministic rule-based scorecards — not ML.** What the codebase demonstrates instead is that the pipeline is *model-agnostic by construction*, so a supervised scorer drops into the existing seam without changing the engine, the audit ledger, or the adverse-action layer:

- **`FeatureExtractor` → `FeatureVector`.** Every strategy consumes a derived `FeatureVector`, not raw telemetry. This is the boundary that, in production, enforces **training/serving parity** — the single most common failure mode in deployed credit models is features computed one way at training time and another at serving time. Centralizing derivation here is the architectural fix.
- **`ModelBackedUnderwritingStrategy` (stub).** Implements the same `UnderwritingStrategy` contract as the rule tracks, but reads an `externalProbabilityOfDefault` that a model-serving layer (SageMaker / Seldon / BentoML) would populate. It fails *closed* to a conservative PD when no model is present. Swapping a gradient-boosted model (XGBoost/LightGBM) in means implementing this one method — nothing else in the pipeline changes.
- **SHAP → adverse-action.** The stub documents how per-feature SHAP values map onto the existing `ScoringFactor` / `adverseActionReasons` structures, so an ML decision stays FCAC-compliant with no black-box exceptions: the reason codes a regulator requires fall out of the same disclosure path the rule tracks already use.

The point of the seam is to show the *infrastructure* a production ML credit decision needs — feature parity, a model-agnostic scoring interface, and explainability wired through to compliance — without overclaiming a model that isn't there.

---

## Securitization guard

Independent of the credit decision, these deterministic rules protect institutional / bank-partner asset pools. The most severe rule wins (a single event yields at most one flag).

- **Velocity (CRITICAL)** — transaction `amount` strictly greater than `5×` average daily spend → bust-out fraud signature.
- **Cash-out leak (HIGH)** — MCC `6011` (ATM) or `6051` (quasi-cash/crypto) with `amount` strictly greater than `$2,000` → unauthorized liquidity extraction.

A transaction can be **approved on credit merit yet flagged for compliance** — the two layers answer different questions (see Profile D below).

---

## Tamper-evident audit ledger

Every decision is committed to an append-only ledger in which each entry embeds the SHA-256 hash of its predecessor (genesis-anchored). Any retroactive edit, deletion, or reordering breaks the chain and is detected by `verifyIntegrity()` — a lightweight, dependency-free integrity control built on Node's standard `crypto`. The orchestrator verifies the chain live at the end of every run.

---

## Demonstration profiles

The streamer emits **20 engineered profiles** spanning both pools and every decision path — an evenly split portfolio (10 `TIMS_MIGRATION_POOL` / 10 `NEO_NATIVE_SECURED`) producing an 85% approval rate, three CRITICAL and three HIGH securitization flags, and seven thin-file alternative-data inclusions. The five below are the canonical cases each exercising a distinct behavior; the remaining fifteen populate the portfolio KPIs and tier/track distributions shown on the dashboard.

| Account | Pool → Track | Outcome |
| --- | --- | --- |
| `ALT_CREDIT_001` | TIMS → Alternative | **100 / LOW** — alt-data approval (inclusion thesis) |
| `STD_CREDIT_002` | Neo-native → Traditional | **85 / LOW** — standard secured approval (routing payoff) |
| `FRAUD_BUST_OUT_003` | TIMS → Alternative | **30 / DECLINE** + **CRITICAL** velocity flag |
| `CASH_OUT_LEAK_004` | Neo-native → Traditional | **80 / LOW** but **HIGH** cash-out flag (layer independence) |
| `EDGE_BOUNDARY_005` | TIMS → Alternative | **50 / HIGH** — exclusive-boundary correctness (rent = 12, reserve = 1.0) |

---

## Running it

```bash
npm install        # install dev tooling (typescript, tsx, @types/node)
npm start          # run the pipeline end to end (also regenerates the dashboard)
npm test           # run the 25-spec test suite (node:test)
npm run typecheck  # strict type-check of src + test (no emit)
npm run build      # compile src to ./dist with declarations
npm run dev        # watch mode
```

> **Monetary convention:** all amounts are integer **USD cents**; dollars are produced only at the presentation boundary to eliminate floating-point drift in ABS accounting.

---

## Dashboard

Every run regenerates a **self-contained static dashboard** at [`docs/index.html`](docs/index.html) — a data-driven view of the run's decisions, portfolio KPIs, tier/track distribution, and the verified audit chain. It has **zero dependencies**: the data is inlined at generation time, so the file opens directly in any browser and hosts unchanged on GitHub Pages.

```bash
npm start                    # regenerates docs/index.html from the latest run
# then open docs/index.html in a browser
```

**Publish it on GitHub Pages:** repository **Settings → Pages → Source: Deploy from a branch → `main` / `/docs`**. The dashboard is then live at `https://<user>.github.io/<repo>/`.

---

## Domain context

The pool names in this codebase are intentional, not placeholders.

`TIMS_MIGRATION_POOL` mirrors the real challenge facing lenders who acquire thin-file cardholders from a dissolved co-brand partnership: those borrowers have transaction history, rent discipline, and cash-flow patterns — but no FICO trail with the acquiring institution. Judging them on a traditional secured-credit model produces false declines and abandons the inclusion thesis that justified the partnership in the first place. The alternative-data track is the architectural answer to that problem.

`SecuritizationGuardEngine` reflects the parallel pressure: once a lender structures debt assets into an ABS facility and sells tranches to institutional investors, every transaction in the underlying pool becomes an asset-quality event. Velocity anomalies and unauthorized liquidity extractions (MCC 6011/6051) aren't just fraud — they're events that degrade pool collateral and expose the originator to investor scrutiny. The guard engine runs independent of the credit decision because the two questions — *is this borrower creditworthy?* and *is this transaction safe for our ABS pool?* — have different answerers with different stakes.

**Scope note:** this is a domain-modeled demonstration of the architectural decisions involved, not a production system. It ships no trained model (the active tracks are deterministic scorecards — see *ML-readiness*), no real data store, and no API surface. Its purpose is to make the engineering trade-offs explicit and testable.

---

## Design principles

- **Zero runtime dependencies** — only `typescript`, `tsx`, and `@types/node` as dev tooling.
- **Full `strict` TypeScript** — plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `verbatimModuleSyntax`.
- **Strategy pattern + dependency injection** — the engine is closed for modification, open for extension; new pools require a new strategy, not an engine change.
- **Single-responsibility modules** — ingestion, scoring, detection, audit, and metrics are independently testable and replaceable.
- **Explainable, auditable, observable** — reason codes, a tamper-evident ledger, and pool-health KPIs are built in.
