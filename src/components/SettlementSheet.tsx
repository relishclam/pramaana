/**
 * SettlementSheet — Pramaana settlement voucher, TWO MODES.
 *
 *   mode="receipt"  Sales → Receipts   (buyers who owe us)
 *   mode="payment"  Purchase/Salary → Payments  (vendors & staff we owe)
 *
 * Logic, state, and RPC calls are unchanged from the original.
 * Presentation rebuilt with SettlementSheet.module.css using Pramaana design tokens.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabasePramaana } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import css from './SettlementSheet.module.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SettlementMode = 'receipt' | 'payment';

interface Ledger {
  id: string;
  name: string;
}

interface PartyConfig {
  id: string;
  ledger_id: string;
  party_type: 'buyer' | 'vendor' | 'staff';
  tds_section_code: string | null;
  tds_rate: number | null;
  advance_outstanding: number;
  advance_recovery_monthly: number | null;
}

interface OpenDocument {
  voucher_id: string;
  voucher_number: string;
  voucher_date: string;
  narration: string | null;
  doc_total: number;
  amount_settled: number;
  outstanding: number;
}

interface BankLine {
  key: string;
  bank_ledger_id: string;
  line_date: string;
  amount: string;
  bank_reference: string;
}

export interface SettlementSheetProps {
  mode: SettlementMode;
  companyId: string;
  bankLedgers: Ledger[];
  partyLedgers: Ledger[];
  tdsLedgerId: string;
  advanceLedgerResolver: (partyLedgerId: string) => Promise<string | null>;
  tdsBaseDivisor?: number;
  onPosted?: (voucherId: string, voucherNumber: string) => void;
}

// ---------------------------------------------------------------------------
// Per-mode wiring
// ---------------------------------------------------------------------------

const MODE = {
  receipt: {
    eyebrow:         'RECEIPT VOUCHER · SETTLEMENT MODE',
    heading:         'Invoice settlement',
    docLabel:        'Outstanding invoice',
    docEmpty:        'No open invoices',
    zoneALabel:      'ZONE A — BANK RECEIPTS',
    zoneATotal:      'Cash received',
    zoneBTdsSub:     (cfg: PartyConfig | null) =>
      cfg?.tds_rate ? `${cfg.tds_rate}% on taxable value → TDS Receivable` : 'Deducted by payer → TDS Receivable',
    zoneBAdvanceSub: 'Runs down the deposit we hold',
    submit:          'Post settlement receipt',
    listRpc:         'get_outstanding_invoices',
    listTotalKey:    'invoice_total',
    postRpc:         'post_settlement_receipt',
    docParam:        'p_invoice_voucher_id',
    dateKey:         'receipt_date',
    resultIdKey:     'receipt_voucher_id',
  },
  payment: {
    eyebrow:         'PAYMENT VOUCHER · SETTLEMENT MODE',
    heading:         'Bill / salary settlement',
    docLabel:        'Outstanding bill',
    docEmpty:        'No open bills',
    zoneALabel:      'ZONE A — BANK PAYMENTS',
    zoneATotal:      'Cash paid',
    zoneBTdsSub:     (cfg: PartyConfig | null) =>
      cfg?.tds_rate ? `${cfg.tds_rate}% we deduct → TDS Payable` : 'We deduct → TDS Payable',
    zoneBAdvanceSub: 'Recovers the advance we gave',
    submit:          'Post settlement payment',
    listRpc:         'get_outstanding_bills',
    listTotalKey:    'bill_total',
    postRpc:         'post_settlement_payment',
    docParam:        'p_bill_voucher_id',
    dateKey:         'payment_date',
    resultIdKey:     'payment_voucher_id',
  },
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const inr = new Intl.NumberFormat('en-IN', {
  style:                 'currency',
  currency:              'INR',
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

const fmt = (n: number) => inr.format(Math.round(n * 100) / 100);

const num = (s: string): number => {
  const v = parseFloat(s.replace(/,/g, ''));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

const todayISO = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
};

let lineSeq = 0;
const newBankLine = (defaultBankId: string): BankLine => ({
  key:            `bl-${++lineSeq}`,
  bank_ledger_id: defaultBankId,
  line_date:      '',          // intentionally blank — user must enter the real transaction date
  amount:         '',
  bank_reference: '',
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SettlementSheet({
  mode,
  companyId,
  bankLedgers,
  partyLedgers,
  tdsLedgerId,
  advanceLedgerResolver,
  tdsBaseDivisor = 1.18,
  onPosted,
}: SettlementSheetProps) {
  const M = MODE[mode];

  const [partyLedgerId,   setPartyLedgerId]   = useState('');
  const [partyConfig,     setPartyConfig]     = useState<PartyConfig | null>(null);
  const [documents,       setDocuments]       = useState<OpenDocument[]>([]);
  const [documentId,      setDocumentId]      = useState('');
  const [loadingParty,    setLoadingParty]    = useState(false);

  const [bankLines,       setBankLines]       = useState<BankLine[]>([]);
  const [tdsAmount,       setTdsAmount]       = useState('0');
  const [advanceAmount,   setAdvanceAmount]   = useState('0');
  const [advanceLedgerId, setAdvanceLedgerId] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  const selectedDoc = useMemo(
    () => documents.find((d) => d.voucher_id === documentId) ?? null,
    [documents, documentId],
  );

  // ── party selection → config + open documents ─────────────────────────────

  const loadParty = useCallback(
    async (ledgerId: string) => {
      setLoadingParty(true);
      setError(null);
      setPartyConfig(null);
      setDocuments([]);
      setDocumentId('');
      setBankLines([]);
      setTdsAmount('0');
      setAdvanceAmount('0');
      setAdvanceLedgerId(null);

      try {
        const { data: cfg } = await supabasePramaana
          .from('party_config')
          .select('id, ledger_id, party_type, tds_section_code, tds_rate, advance_outstanding, advance_recovery_monthly')
          .eq('company_id', companyId)
          .eq('ledger_id', ledgerId)
          .maybeSingle();
        if (cfg) setPartyConfig(cfg as PartyConfig);

        const { data: docs, error: docErr } = await supabasePramaana.rpc(M.listRpc, {
          p_company_id:      companyId,
          p_party_ledger_id: ledgerId,
        });
        if (docErr) throw docErr;

        // Task 4: derive advance_outstanding from the actual ledger balance
        const advLedgerId = await advanceLedgerResolver(ledgerId);
        setAdvanceLedgerId(advLedgerId);
        if (cfg && advLedgerId) {
          const { data: entries } = await supabasePramaana
            .from('voucher_entries')
            .select('entry_type, amount, vouchers!inner(status, company_id)')
            .eq('ledger_id', advLedgerId)
            .eq('vouchers.company_id', companyId)
            .eq('vouchers.status', 'posted');
          if (entries) {
            const liveBalance = (entries as { entry_type: string; amount: number }[])
              .reduce((s, e) => s + (e.entry_type === 'Cr' ? e.amount : -e.amount), 0);
            setPartyConfig({ ...(cfg as PartyConfig), advance_outstanding: Math.max(0, liveBalance) });
          }
        }

        setDocuments(
          ((docs ?? []) as Record<string, unknown>[]).map((d) => ({  // eslint-disable-line
            voucher_id:     d.voucher_id     as string,
            voucher_number: d.voucher_number as string,
            voucher_date:   d.voucher_date   as string,
            narration:      (d.narration as string) ?? null,
            doc_total:      Number(d[M.listTotalKey]),
            amount_settled: Number(d.amount_settled),
            outstanding:    Number(d.outstanding),
          })),
        );

        // advance ledger already resolved above (Task 4)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load party data');
      } finally {
        setLoadingParty(false);
      }
    },
    [companyId, advanceLedgerResolver, M.listRpc, M.listTotalKey],
  );

  useEffect(() => {
    if (partyLedgerId) void loadParty(partyLedgerId);
  }, [partyLedgerId, loadParty]);

  // ── document selection → auto-fill zone B ─────────────────────────────────
  // Only auto-fill TDS + advance when outstanding ≈ doc_total (first/only
  // settlement of the invoice).  For residuals (partially-settled invoices)
  // Zone B starts at 0/0 — the standard monthly amounts would over-apply.

  useEffect(() => {
    if (!selectedDoc) return;

    const isFirstSettlement = selectedDoc.outstanding >= selectedDoc.doc_total - 1.0;

    if (isFirstSettlement && partyConfig?.tds_rate) {
      const base = selectedDoc.doc_total / tdsBaseDivisor;
      setTdsAmount(((base * partyConfig.tds_rate) / 100).toFixed(2));
    } else {
      setTdsAmount('0');
    }

    if (isFirstSettlement && partyConfig?.advance_recovery_monthly) {
      setAdvanceAmount(
        Math.min(partyConfig.advance_recovery_monthly, partyConfig.advance_outstanding).toFixed(2),
      );
    } else {
      setAdvanceAmount('0');
    }

    if (bankLines.length === 0 && bankLedgers.length > 0) {
      setBankLines([newBankLine(bankLedgers[0].id)]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDoc, partyConfig]);

  // ── live balance ───────────────────────────────────────────────────────────

  const sumBank = useMemo(
    () => bankLines.reduce((s: number, l: BankLine) => s + num(l.amount), 0),
    [bankLines],
  );
  const tds       = num(tdsAmount);
  const advance   = num(advanceAmount);
  const docOpen   = selectedDoc?.outstanding ?? 0;
  const applied   = sumBank + tds + advance;
  const remaining = Math.round((docOpen - applied) * 100) / 100;

  const overApplied  = remaining < 0;
  const fullySettled = remaining === 0 && applied > 0;
  const hasBlankDate = bankLines.some((l: BankLine) => num(l.amount) > 0 && !l.line_date);
  const canSubmit    = !!selectedDoc && applied > 0 && !overApplied && !hasBlankDate && !submitting;

  // ── bank line handlers ─────────────────────────────────────────────────────

  const updateLine = (key: string, patch: Partial<BankLine>) =>
    setBankLines((ls: BankLine[]) => ls.map((l: BankLine) => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = () =>
    setBankLines((ls: BankLine[]) => [...ls, newBankLine(bankLedgers[0]?.id ?? '')]);
  const removeLine = (key: string) =>
    setBankLines((ls: BankLine[]) => ls.filter((l: BankLine) => l.key !== key));

  // ── submit ─────────────────────────────────────────────────────────────────

  const { user } = useAuth();

  const handleSubmit = async () => {
    if (!selectedDoc || !canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      const params: Record<string, unknown> = {
        p_company_id:        companyId,
        p_created_by:        user?.id ?? null,
        p_party_ledger_id:   partyLedgerId,
        [M.docParam]:        selectedDoc.voucher_id,
        p_bank_lines:        bankLines
          .filter((l: BankLine) => num(l.amount) > 0)
          .map((l: BankLine) => ({
            bank_ledger_id: l.bank_ledger_id,
            [M.dateKey]:    l.line_date,
            amount:         num(l.amount),
            bank_reference: l.bank_reference || null,
          })),
        p_tds_amount:        tds,
        p_tds_ledger_id:     tds > 0 ? tdsLedgerId : null,
        p_tds_section_code:  partyConfig?.tds_section_code ?? null,
        p_advance_amount:    advance,
        p_advance_ledger_id: advance > 0 ? advanceLedgerId : null,
      };

      const { data, error: rpcErr } = await supabasePramaana.rpc(M.postRpc, params);
      if (rpcErr) throw rpcErr;

      const result = data as Record<string, string>;
      onPosted?.(result[M.resultIdKey], result.voucher_number);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Settlement failed');
    } finally {
      setSubmitting(false);
    }
  };

  // ── balance bar class ──────────────────────────────────────────────────────

  const balanceBarClass = overApplied
    ? css.balanceBarError
    : fullySettled
      ? css.balanceBarSuccess
      : css.balanceBar;

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <div className={css.form}>

      {/* Picker card */}
      <div className={css.pickerCard}>
        <div className={css.pickerGrid}>
          <div className={css.field}>
            <label className={css.label}>Party</label>
            <select
              className={css.select}
              value={partyLedgerId}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setPartyLedgerId(e.target.value)}
            >
              <option value="">Select party…</option>
              {partyLedgers.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div className={css.field}>
            <label className={css.label}>{M.docLabel}</label>
            <select
              className={css.select}
              value={documentId}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setDocumentId(e.target.value)}
              disabled={loadingParty || documents.length === 0}
            >
              <option value="">
                {loadingParty ? 'Loading…' : documents.length === 0 ? M.docEmpty : 'Select…'}
              </option>
              {documents.map((d) => (
                <option key={d.voucher_id} value={d.voucher_id}>
                  {d.voucher_number} · {d.voucher_date} · {fmt(d.outstanding)} open
                </option>
              ))}
            </select>
          </div>
        </div>

        {loadingParty && (
          <div className={css.configLoading}>Loading party configuration…</div>
        )}
        {!loadingParty && partyConfig && (
          <div className={css.configBanner}>
            {partyConfig.tds_section_code && (
              <span className={css.configItem}>
                <span className={css.configItemLabel}>TDS</span>
                {partyConfig.tds_section_code} @ {partyConfig.tds_rate}%
              </span>
            )}
            <span className={css.configItem}>
              <span className={css.configItemLabel}>Advance outstanding</span>
              {fmt(partyConfig.advance_outstanding)}
              {partyConfig.advance_recovery_monthly &&
                ` · recovery ${fmt(partyConfig.advance_recovery_monthly)}/mo`}
            </span>
          </div>
        )}
      </div>

      {/* Zones + balance (only once a document is selected) */}
      {selectedDoc && (
        <>
          <div className={css.zonesGrid}>

            {/* Zone A — bank lines */}
            <div className={css.card}>
              <div className={css.cardHeader}>
                <span className={css.cardLabel}>{M.zoneALabel}</span>
                <button type="button" className={css.addLineBtn} onClick={addLine}>
                  + Add line
                </button>
              </div>
              <div className={css.cardBody}>
                <div className={css.bankLines}>
                  {bankLines.map((l) => (
                    <div key={l.key} className={css.bankLine}>
                      <select
                        className={css.lineSelect}
                        value={l.bank_ledger_id}
                        onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                          updateLine(l.key, { bank_ledger_id: e.target.value })
                        }
                      >
                        {bankLedgers.map((b) => (
                          <option key={b.id} value={b.id}>{b.name}</option>
                        ))}
                      </select>
                      <input
                        type="date"
                        className={`${css.lineControl}${!l.line_date && num(l.amount) > 0 ? ` ${css.lineControlError}` : ''}`}
                        value={l.line_date}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          updateLine(l.key, { line_date: e.target.value })
                        }
                      />
                      <input
                        inputMode="decimal"
                        placeholder="Amount"
                        className={css.lineAmt}
                        value={l.amount}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          updateLine(l.key, { amount: e.target.value })
                        }
                      />
                      <input
                        placeholder="UTR / NEFT ref"
                        className={css.lineControl}
                        value={l.bank_reference}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          updateLine(l.key, { bank_reference: e.target.value })
                        }
                      />
                      <button
                        type="button"
                        aria-label="Remove line"
                        className={css.lineRemoveBtn}
                        onClick={() => removeLine(l.key)}
                        disabled={bankLines.length === 1}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              <div className={css.cardFooter}>
                <span className={css.footerLabel}>{M.zoneATotal}</span>
                <span className={css.footerValueTeal}>{fmt(sumBank)}</span>
              </div>
            </div>

            {/* Zone B — adjustments */}
            <div className={css.card}>
              <div className={css.cardHeader}>
                <span className={css.cardLabel}>ZONE B — ADJUSTMENTS</span>
              </div>
              <div className={css.cardBody}>
                <div className={css.adjustRows}>
                  <div className={css.adjustRow}>
                    <div className={css.adjustMeta}>
                      <div className={css.adjustName}>
                        TDS{partyConfig?.tds_section_code
                          ? ` · Section ${partyConfig.tds_section_code}`
                          : ''}
                      </div>
                      <div className={css.adjustSub}>{M.zoneBTdsSub(partyConfig)}</div>
                    </div>
                    <input
                      inputMode="decimal"
                      className={css.adjustInput}
                      value={tdsAmount}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTdsAmount(e.target.value)}
                    />
                  </div>

                  <div className={css.adjustRow}>
                    <div className={css.adjustMeta}>
                      <div className={css.adjustName}>Advance recovery</div>
                      <div className={css.adjustSub}>
                        {partyConfig
                          ? `${M.zoneBAdvanceSub} · ${fmt(partyConfig.advance_outstanding)} left`
                          : 'No advance configured'}
                      </div>
                    </div>
                    <input
                      inputMode="decimal"
                      className={css.adjustInput}
                      value={advanceAmount}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAdvanceAmount(e.target.value)}
                      disabled={!advanceLedgerId}
                    />
                  </div>
                </div>
              </div>
              <div className={css.cardFooter}>
                <span className={css.footerLabel}>Total adjustments</span>
                <span className={css.footerValueAmber}>{fmt(tds + advance)}</span>
              </div>
            </div>
          </div>

          {/* Balance bar */}
          <div className={balanceBarClass}>
            <div className={css.balanceGrid}>
              <div className={css.balanceStat}>
                <div className={css.statLabel}>Open balance</div>
                <div className={css.statValue}>{fmt(docOpen)}</div>
              </div>
              <div className={css.balanceStat}>
                <div className={css.statLabel}>Bank</div>
                <div className={css.statValueTeal}>{fmt(sumBank)}</div>
              </div>
              <div className={css.balanceStat}>
                <div className={css.statLabel}>Adjusted</div>
                <div className={css.statValueAmber}>{fmt(tds + advance)}</div>
              </div>
              <div className={css.balanceStat}>
                <div className={css.statLabel}>Remaining</div>
                <div className={
                  overApplied  ? css.statValueError
                  : fullySettled ? css.statValueSuccess
                  : css.statValue
                }>
                  {fmt(remaining)}
                </div>
                {fullySettled  && <span className={css.chipSuccess}>Fully settled</span>}
                {overApplied   && <span className={css.chipError}>Over-applied</span>}
                {hasBlankDate  && <span className={css.chipError}>Enter bank date(s)</span>}
                {!fullySettled && !overApplied && !hasBlankDate && applied > 0 && (
                  <span className={css.chipPartPaid}>Part-paid</span>
                )}
              </div>
            </div>
          </div>

          {error && <div className={css.errorMsg}>{error}</div>}

          <div className={css.submitRow}>
            <button
              type="button"
              className={css.btnPrimary}
              onClick={handleSubmit}
              disabled={!canSubmit}
            >
              {submitting ? 'Posting…' : M.submit}
            </button>
          </div>
        </>
      )}

      {partyLedgerId && !loadingParty && documents.length > 0 && !selectedDoc && (
        <div className={css.emptyDoc}>Select an outstanding document above to begin.</div>
      )}
    </div>
  );
}
