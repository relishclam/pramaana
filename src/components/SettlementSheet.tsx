/**
 * SettlementSheet — Pramaana settlement voucher, TWO MODES.
 *
 *   mode="receipt"  Sales → Receipts   (buyers who owe us)
 *     Zone A: bank credits in           → Dr bank lines
 *     Zone B: TDS they deducted         → Dr TDS Receivable
 *             advance-deposit rundown   → Dr their deposit (liability shrinks)
 *     Clears:                           → Cr party
 *     RPCs: get_outstanding_invoices / post_settlement_receipt
 *
 *   mode="payment"  Purchase/Salary → Payments  (vendors & staff we owe)
 *     Zone A: bank debits out           → Cr bank lines
 *     Zone B: TDS we deduct (194C/192)  → Cr TDS Payable
 *             salary/supplier advance   → Cr advance asset (recovery)
 *     Clears:                           → Dr party
 *     RPCs: get_outstanding_bills / post_settlement_payment
 *
 * Both modes share party_config auto-fill, the live balance bar, and the
 * rule: bank + TDS + advance must not exceed the open balance. Exactly
 * zero → 'settled'; short → 'part_paid'.
 *
 * Schema: pramaana — uses supabasePramaana (db: { schema: 'pramaana' }).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabasePramaana } from '@/lib/supabase';

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

interface SettlementSheetProps {
  mode: SettlementMode;
  companyId: string;
  /** Bank Accounts group ledgers for this company */
  bankLedgers: Ledger[];
  /** Party ledgers: Sundry Debtors (receipt) / Sundry Creditors + Staff (payment) */
  partyLedgers: Ledger[];
  /**
   * TDS control ledger:
   *   receipt → "TDS Receivable" (asset — tax others deducted from us)
   *   payment → "TDS Payable"    (liability — tax we deduct, owed to govt)
   */
  tdsLedgerId: string;
  /**
   * Resolves the advance ledger for a party:
   *   receipt → their deposit we hold (e.g. "Rent Deposit Recived" for Peninsular)
   *   payment → advance asset we gave (e.g. "Salary Advance — <name>")
   * Return null if the party has no advance ledger.
   */
  advanceLedgerResolver: (partyLedgerId: string) => Promise<string | null>;
  /**
   * Divisor to derive the TDS base from the GST-inclusive open amount.
   * Default 1.18 (CGST 9 + SGST 9, the Peninsular rent pattern).
   * Pass 1 when the document total IS the base (e.g. salary journals).
   * TDS is always editable after auto-fill.
   */
  tdsBaseDivisor?: number;
  onPosted?: (voucherId: string, voucherNumber: string) => void;
}

// ---------------------------------------------------------------------------
// Per-mode wiring — everything that differs lives here
// ---------------------------------------------------------------------------

const MODE = {
  receipt: {
    eyebrow: 'RECEIPT VOUCHER · SETTLEMENT MODE',
    heading: 'Invoice settlement',
    docLabel: 'Outstanding invoice',
    docEmpty: 'No open invoices',
    zoneA: 'Zone A — bank receipts',
    zoneATotal: 'Cash received',
    zoneBTdsSub: (cfg: PartyConfig | null) =>
      cfg?.tds_rate
        ? `${cfg.tds_rate}% on taxable value → TDS Receivable`
        : 'Deducted by payer → TDS Receivable',
    zoneBAdvanceSub: 'Runs down the deposit we hold',
    submit: 'Post settlement receipt',
    listRpc: 'get_outstanding_invoices',
    listTotalKey: 'invoice_total',
    postRpc: 'post_settlement_receipt',
    docParam: 'p_invoice_voucher_id',
    dateKey: 'receipt_date',
    resultIdKey: 'receipt_voucher_id',
  },
  payment: {
    eyebrow: 'PAYMENT VOUCHER · SETTLEMENT MODE',
    heading: 'Bill / salary settlement',
    docLabel: 'Outstanding bill',
    docEmpty: 'No open bills',
    zoneA: 'Zone A — bank payments',
    zoneATotal: 'Cash paid',
    zoneBTdsSub: (cfg: PartyConfig | null) =>
      cfg?.tds_rate
        ? `${cfg.tds_rate}% we deduct → TDS Payable`
        : 'We deduct → TDS Payable',
    zoneBAdvanceSub: 'Recovers the advance we gave',
    submit: 'Post settlement payment',
    listRpc: 'get_outstanding_bills',
    listTotalKey: 'bill_total',
    postRpc: 'post_settlement_payment',
    docParam: 'p_bill_voucher_id',
    dateKey: 'payment_date',
    resultIdKey: 'payment_voucher_id',
  },
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

const fmt = (n: number) => inr.format(Math.round(n * 100) / 100);

const num = (s: string): number => {
  const v = parseFloat(s.replace(/,/g, ''));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

const todayISO = () => new Date().toISOString().slice(0, 10);

let lineSeq = 0;
const newBankLine = (defaultBankId: string): BankLine => ({
  key: `bl-${++lineSeq}`,
  bank_ledger_id: defaultBankId,
  line_date: todayISO(),
  amount: '',
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

  const [partyLedgerId, setPartyLedgerId] = useState('');
  const [partyConfig, setPartyConfig] = useState<PartyConfig | null>(null);
  const [documents, setDocuments] = useState<OpenDocument[]>([]);
  const [documentId, setDocumentId] = useState('');
  const [loadingParty, setLoadingParty] = useState(false);

  const [bankLines, setBankLines] = useState<BankLine[]>([]);
  const [tdsAmount, setTdsAmount] = useState('0');
  const [advanceAmount, setAdvanceAmount] = useState('0');
  const [advanceLedgerId, setAdvanceLedgerId] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedDoc = useMemo(
    () => documents.find((d) => d.voucher_id === documentId) ?? null,
    [documents, documentId],
  );

  // ---- party selection → config + open documents ---------------------------
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
          .select(
            'id, ledger_id, party_type, tds_section_code, tds_rate, advance_outstanding, advance_recovery_monthly',
          )
          .eq('company_id', companyId)
          .eq('ledger_id', ledgerId)
          .maybeSingle();
        if (cfg) setPartyConfig(cfg as PartyConfig);

        const { data: docs, error: docErr } = await supabasePramaana.rpc(M.listRpc, {
          p_company_id: companyId,
          p_party_ledger_id: ledgerId,
        });
        if (docErr) throw docErr;

        setDocuments(
          ((docs ?? []) as Record<string, unknown>[]).map((d) => ({
            voucher_id: d.voucher_id as string,
            voucher_number: d.voucher_number as string,
            voucher_date: d.voucher_date as string,
            narration: (d.narration as string) ?? null,
            doc_total: Number(d[M.listTotalKey]),
            amount_settled: Number(d.amount_settled),
            outstanding: Number(d.outstanding),
          })),
        );

        setAdvanceLedgerId(await advanceLedgerResolver(ledgerId));
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

  // ---- document selection → auto-fill zone B -------------------------------
  useEffect(() => {
    if (!selectedDoc) return;

    if (partyConfig?.tds_rate) {
      const base = selectedDoc.doc_total / tdsBaseDivisor;
      setTdsAmount(((base * partyConfig.tds_rate) / 100).toFixed(2));
    }
    if (partyConfig?.advance_recovery_monthly) {
      setAdvanceAmount(
        Math.min(
          partyConfig.advance_recovery_monthly,
          partyConfig.advance_outstanding,
        ).toFixed(2),
      );
    }
    if (bankLines.length === 0 && bankLedgers.length > 0) {
      setBankLines([newBankLine(bankLedgers[0].id)]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDoc, partyConfig]);

  // ---- live balance --------------------------------------------------------
  const sumBank = useMemo(
    () => bankLines.reduce((s, l) => s + num(l.amount), 0),
    [bankLines],
  );
  const tds = num(tdsAmount);
  const advance = num(advanceAmount);
  const docOpen = selectedDoc?.outstanding ?? 0;
  const applied = sumBank + tds + advance;
  const outstanding = Math.round((docOpen - applied) * 100) / 100;

  const overApplied = outstanding < 0;
  const fullySettled = outstanding === 0 && applied > 0;
  const canSubmit = !!selectedDoc && applied > 0 && !overApplied && !submitting;

  // ---- bank line handlers --------------------------------------------------
  const updateLine = (key: string, patch: Partial<BankLine>) =>
    setBankLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = () =>
    setBankLines((ls) => [...ls, newBankLine(bankLedgers[0]?.id ?? '')]);
  const removeLine = (key: string) =>
    setBankLines((ls) => ls.filter((l) => l.key !== key));

  // ---- submit --------------------------------------------------------------
  const handleSubmit = async () => {
    if (!selectedDoc || !canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      const params: Record<string, unknown> = {
        p_company_id: companyId,
        p_party_ledger_id: partyLedgerId,
        [M.docParam]: selectedDoc.voucher_id,
        p_bank_lines: bankLines
          .filter((l) => num(l.amount) > 0)
          .map((l) => ({
            bank_ledger_id: l.bank_ledger_id,
            [M.dateKey]: l.line_date,
            amount: num(l.amount),
            bank_reference: l.bank_reference || null,
          })),
        p_tds_amount: tds,
        p_tds_ledger_id: tds > 0 ? tdsLedgerId : null,
        p_tds_section_code: partyConfig?.tds_section_code ?? null,
        p_advance_amount: advance,
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

  // ---- render --------------------------------------------------------------
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <header>
        <p className="text-[11px] font-medium tracking-wide text-neutral-500">
          {M.eyebrow}
        </p>
        <h1 className="text-lg font-semibold text-neutral-900">{M.heading}</h1>
      </header>

      {/* Party + document pickers */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-neutral-600">
            Party
          </span>
          <select
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            value={partyLedgerId}
            onChange={(e) => setPartyLedgerId(e.target.value)}
          >
            <option value="">Select party…</option>
            {partyLedgers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-neutral-600">
            {M.docLabel}
          </span>
          <select
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            value={documentId}
            onChange={(e) => setDocumentId(e.target.value)}
            disabled={loadingParty || documents.length === 0}
          >
            <option value="">
              {loadingParty
                ? 'Loading…'
                : documents.length === 0
                  ? M.docEmpty
                  : 'Select…'}
            </option>
            {documents.map((d) => (
              <option key={d.voucher_id} value={d.voucher_id}>
                {d.voucher_number} · {d.voucher_date} · {fmt(d.outstanding)} open
              </option>
            ))}
          </select>
        </label>
      </section>

      {/* Party config summary */}
      {partyConfig && (
        <div className="rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-900">
          {partyConfig.tds_section_code && (
            <span className="mr-3">
              TDS {partyConfig.tds_section_code} @ {partyConfig.tds_rate}%
            </span>
          )}
          <span>
            Advance outstanding: {fmt(partyConfig.advance_outstanding)}
            {partyConfig.advance_recovery_monthly &&
              ` · recovery ${fmt(partyConfig.advance_recovery_monthly)}/mo`}
          </span>
        </div>
      )}

      {selectedDoc && (
        <>
          {/* Zone A */}
          <section className="rounded-lg border border-neutral-200 bg-white p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-semibold text-neutral-600">
                {M.zoneA}
              </h2>
              <button
                type="button"
                onClick={addLine}
                className="rounded border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600 hover:bg-neutral-50"
              >
                + Add line
              </button>
            </div>

            <div className="space-y-2">
              {bankLines.map((l) => (
                <div
                  key={l.key}
                  className="grid grid-cols-[1fr_130px_120px_1fr_28px] items-center gap-2"
                >
                  <select
                    className="rounded border border-neutral-300 px-2 py-1.5 text-xs"
                    value={l.bank_ledger_id}
                    onChange={(e) =>
                      updateLine(l.key, { bank_ledger_id: e.target.value })
                    }
                  >
                    {bankLedgers.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="date"
                    className="rounded border border-neutral-300 px-2 py-1.5 text-xs"
                    value={l.line_date}
                    onChange={(e) =>
                      updateLine(l.key, { line_date: e.target.value })
                    }
                  />
                  <input
                    inputMode="decimal"
                    placeholder="Amount"
                    className="rounded border border-neutral-300 px-2 py-1.5 text-right text-xs"
                    value={l.amount}
                    onChange={(e) => updateLine(l.key, { amount: e.target.value })}
                  />
                  <input
                    placeholder="Bank reference (UTR/NEFT)"
                    className="rounded border border-neutral-300 px-2 py-1.5 text-xs"
                    value={l.bank_reference}
                    onChange={(e) =>
                      updateLine(l.key, { bank_reference: e.target.value })
                    }
                  />
                  <button
                    type="button"
                    aria-label="Remove line"
                    onClick={() => removeLine(l.key)}
                    disabled={bankLines.length === 1}
                    className="text-neutral-400 hover:text-red-600 disabled:opacity-30"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            <div className="mt-3 flex justify-between border-t border-neutral-100 pt-2 text-sm">
              <span className="text-neutral-500">{M.zoneATotal}</span>
              <span className="font-semibold text-emerald-700">
                {fmt(sumBank)}
              </span>
            </div>
          </section>

          {/* Zone B */}
          <section className="rounded-lg border border-neutral-200 bg-white p-4">
            <h2 className="mb-2 text-xs font-semibold text-neutral-600">
              Zone B — adjustments
            </h2>

            <div className="space-y-2">
              <div className="grid grid-cols-[1fr_140px] items-center gap-2">
                <div>
                  <p className="text-sm text-neutral-800">
                    TDS
                    {partyConfig?.tds_section_code
                      ? ` · Section ${partyConfig.tds_section_code}`
                      : ''}
                  </p>
                  <p className="text-xs text-neutral-500">
                    {M.zoneBTdsSub(partyConfig)}
                  </p>
                </div>
                <input
                  inputMode="decimal"
                  className="rounded border border-neutral-300 px-2 py-1.5 text-right text-sm"
                  value={tdsAmount}
                  onChange={(e) => setTdsAmount(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-[1fr_140px] items-center gap-2">
                <div>
                  <p className="text-sm text-neutral-800">Advance recovery</p>
                  <p className="text-xs text-neutral-500">
                    {partyConfig
                      ? `${M.zoneBAdvanceSub} · ${fmt(partyConfig.advance_outstanding)} left`
                      : 'No advance configured'}
                  </p>
                </div>
                <input
                  inputMode="decimal"
                  className="rounded border border-neutral-300 px-2 py-1.5 text-right text-sm"
                  value={advanceAmount}
                  onChange={(e) => setAdvanceAmount(e.target.value)}
                  disabled={!advanceLedgerId}
                />
              </div>
            </div>

            <div className="mt-3 flex justify-between border-t border-neutral-100 pt-2 text-sm">
              <span className="text-neutral-500">Total adjustments</span>
              <span className="font-semibold text-amber-700">
                {fmt(tds + advance)}
              </span>
            </div>
          </section>

          {/* Balance bar */}
          <section
            className={`rounded-lg border p-4 ${
              overApplied
                ? 'border-red-300 bg-red-50'
                : fullySettled
                  ? 'border-emerald-300 bg-emerald-50'
                  : 'border-neutral-200 bg-neutral-50'
            }`}
          >
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <p className="text-xs text-neutral-500">Open balance</p>
                <p className="font-semibold">{fmt(docOpen)}</p>
              </div>
              <div>
                <p className="text-xs text-neutral-500">Bank</p>
                <p className="font-semibold text-emerald-700">{fmt(sumBank)}</p>
              </div>
              <div>
                <p className="text-xs text-neutral-500">Adjusted</p>
                <p className="font-semibold text-amber-700">
                  {fmt(tds + advance)}
                </p>
              </div>
              <div>
                <p className="text-xs text-neutral-500">Remaining</p>
                <p
                  className={`font-semibold ${
                    overApplied
                      ? 'text-red-700'
                      : fullySettled
                        ? 'text-emerald-700'
                        : 'text-neutral-900'
                  }`}
                >
                  {fmt(outstanding)}
                </p>
                {fullySettled && (
                  <span className="mt-0.5 inline-block rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800">
                    Fully settled
                  </span>
                )}
                {overApplied && (
                  <span className="mt-0.5 inline-block rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-800">
                    Over-applied — reduce amounts
                  </span>
                )}
                {!fullySettled && !overApplied && applied > 0 && (
                  <span className="mt-0.5 inline-block rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] font-medium text-neutral-700">
                    Will post as part-paid
                  </span>
                )}
              </div>
            </div>
          </section>

          {error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
              {error}
            </p>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="rounded-md bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
            >
              {submitting ? 'Posting…' : M.submit}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
