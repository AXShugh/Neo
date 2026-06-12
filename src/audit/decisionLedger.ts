/**
 * @fileoverview Tamper-evident decision ledger for the Neo Risk Pipeline.
 *
 * In a regulated lending and securitization context, every adjudication must be
 * reconstructable and demonstrably unaltered after the fact — for model
 * governance, internal audit, regulatory examination, and dispute resolution.
 *
 * This ledger is an append-only, hash-chained record of every decision and any
 * accompanying anomaly. Each entry embeds the cryptographic hash of its
 * predecessor, so any retroactive edit, deletion, or reordering breaks the chain
 * and is detectable by {@link DecisionLedger.verifyIntegrity}. This is the same
 * integrity primitive that underpins distributed ledgers, applied here as a
 * lightweight, dependency-free audit control using only Node's standard `crypto`.
 */

import { createHash } from 'node:crypto';
import type { UnderwritingResult, AnomalyFlag } from '../types/index.js';

/** SHA-256 digest preceding the first entry (the chain's genesis anchor). */
const GENESIS_HASH = '0'.repeat(64);

/**
 * A single immutable record in the decision ledger.
 *
 * @interface LedgerEntry
 */
export interface LedgerEntry {
  /** Monotonic 1-based position of this entry in the chain. */
  sequence: number;
  /** The decision identifier this entry records. */
  decisionId: string;
  /** Tenant pool identifier. */
  tenantId: string;
  /** Account identifier. */
  accountId: string;
  /** The underwriting track that produced the decision. */
  underwritingTrack: string;
  /** The final risk score. */
  neoRiskScore: number;
  /** The classified risk tier. */
  riskTier: string;
  /** Adverse-action reasons attached to the decision (empty for approvals). */
  adverseActionReasons: string[];
  /** Rule identifier of an accompanying anomaly, or `null` if none fired. */
  anomalyRuleId: string | null;
  /** Severity of an accompanying anomaly, or `null` if none fired. */
  anomalyRiskLevel: string | null;
  /** ISO 8601 timestamp the entry was committed. */
  recordedAt: string;
  /** Hash of the preceding entry (or the genesis anchor for the first entry). */
  previousHash: string;
  /** SHA-256 hash binding this entry's content to the preceding hash. */
  entryHash: string;
}

/** The committable content of an entry, excluding the chain-linking hashes. */
type LedgerEntryBody = Omit<LedgerEntry, 'previousHash' | 'entryHash'>;

/** Result of an integrity verification pass over the chain. */
export interface IntegrityReport {
  /** Whether the chain is internally consistent and unaltered. */
  valid: boolean;
  /** Sequence number of the first broken entry, or `null` if the chain is valid. */
  brokenAtSequence: number | null;
}

/**
 * An append-only, hash-chained ledger of underwriting decisions.
 *
 * @class DecisionLedger
 */
export class DecisionLedger {
  /** The committed chain, in append order. */
  private readonly entries: LedgerEntry[] = [];

  /**
   * Appends a decision (and any accompanying anomaly) to the chain.
   *
   * @param result - The underwriting decision to record.
   * @param anomaly - The anomaly flag raised for the same event, or `null`.
   * @returns The committed {@link LedgerEntry}.
   */
  public record(result: UnderwritingResult, anomaly: AnomalyFlag | null): LedgerEntry {
    const previous = this.entries.at(-1);
    const previousHash = previous ? previous.entryHash : GENESIS_HASH;

    const body: LedgerEntryBody = {
      sequence: this.entries.length + 1,
      decisionId: result.decisionId,
      tenantId: result.tenantId,
      accountId: result.accountId,
      underwritingTrack: result.underwritingTrack,
      neoRiskScore: result.neoRiskScore,
      riskTier: result.riskTier,
      adverseActionReasons: result.adverseActionReasons,
      anomalyRuleId: anomaly ? anomaly.ruleId : null,
      anomalyRiskLevel: anomaly ? anomaly.riskLevel : null,
      recordedAt: new Date().toISOString(),
    };

    const entry: LedgerEntry = {
      ...body,
      previousHash,
      entryHash: this.hashEntry(previousHash, body),
    };

    this.entries.push(entry);
    return entry;
  }

  /**
   * Returns a read-only view of the committed chain.
   *
   * @returns The ledger entries in append order.
   */
  public getEntries(): readonly LedgerEntry[] {
    return this.entries;
  }

  /**
   * Recomputes the entire hash chain and verifies it against the stored hashes.
   *
   * Any retroactive mutation, deletion, or reordering of an entry yields a hash
   * mismatch at or before the affected position, which this method reports.
   *
   * @returns An {@link IntegrityReport} describing the chain's validity.
   */
  public verifyIntegrity(): IntegrityReport {
    let previousHash = GENESIS_HASH;

    for (const entry of this.entries) {
      const body: LedgerEntryBody = {
        sequence: entry.sequence,
        decisionId: entry.decisionId,
        tenantId: entry.tenantId,
        accountId: entry.accountId,
        underwritingTrack: entry.underwritingTrack,
        neoRiskScore: entry.neoRiskScore,
        riskTier: entry.riskTier,
        adverseActionReasons: entry.adverseActionReasons,
        anomalyRuleId: entry.anomalyRuleId,
        anomalyRiskLevel: entry.anomalyRiskLevel,
        recordedAt: entry.recordedAt,
      };
      const expectedHash = this.hashEntry(previousHash, body);

      if (entry.previousHash !== previousHash || entry.entryHash !== expectedHash) {
        return { valid: false, brokenAtSequence: entry.sequence };
      }
      previousHash = entry.entryHash;
    }

    return { valid: true, brokenAtSequence: null };
  }

  /**
   * Computes the SHA-256 hash binding an entry body to its predecessor.
   *
   * The body is serialized with sorted keys so the hash is independent of
   * property declaration order, making the chain robust to refactoring.
   *
   * @param previousHash - The preceding entry's hash (or genesis anchor).
   * @param body - The entry content to commit.
   * @returns The hex-encoded SHA-256 digest.
   */
  private hashEntry(previousHash: string, body: LedgerEntryBody): string {
    const canonical = JSON.stringify(body, Object.keys(body).sort());
    return createHash('sha256').update(previousHash + canonical).digest('hex');
  }
}
