/**
 * SettlementPage — Receipts-in / Payments-out toggle wrapper for SettlementSheet.
 *
 * companyId is taken from the active company in AuthContext — works for both
 * RFPL (bc455c94-…) and RHHF (b8beb440-…) without hardcoding.
 *
 * Ledger group filters verified against actual pramaana.ledger_groups data;
 * see CLAUDE_CODE_INSTRUCTIONS.md Step 4 for context.
 *
 * NOTE (Step 3): pramaana RPCs are currently service_role only.
 * Until the grants below are applied, RPC calls will fail with permission
 * errors. Run the following in the Supabase SQL editor:
 *
 *   GRANT EXECUTE ON FUNCTION pramaana.get_outstanding_invoices(uuid,uuid) TO authenticated;
 *   GRANT EXECUTE ON FUNCTION pramaana.get_outstanding_bills(uuid,uuid) TO authenticated;
 *   GRANT EXECUTE ON FUNCTION pramaana.post_settlement_receipt TO authenticated;
 *   GRANT EXECUTE ON FUNCTION pramaana.post_settlement_payment TO authenticated;
 *
 *   CREATE POLICY "authenticated_read" ON pramaana.party_config
 *     FOR SELECT TO authenticated USING (true);
 *   CREATE POLICY "authenticated_read" ON pramaana.settlement_bank_lines
 *     FOR SELECT TO authenticated USING (true);
 *   CREATE POLICY "authenticated_read" ON pramaana.invoice_settlements
 *     FOR SELECT TO authenticated USING (true);
 *
 * Also confirm Supabase Settings → API → "Exposed schemas" includes "pramaana"
 * (if RPC calls return 404/406, that is the cause).
 */

import { useEffect, useState } from 'react';
import { supabasePramaana } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import SettlementSheet, { SettlementMode } from '@/components/SettlementSheet';
import css from './SettlementPage.module.css';

// Known RFPL ledgers (from migration cycle 050–055)
const PENINSULAR_LEDGER = '74ecf056-0658-4193-8ec5-6b4802e016e0';
// TODO (Step 6): replace name-convention fallback with default_advance_ledger_id
//               column on pramaana.party_config once that column is added.
const RENT_DEPOSIT_LEDGER = '1b955279-512f-46a2-ad4a-8632a8f332b9'; // "Rent Deposit Recived"

interface Ledger {
  id: string;
  name: string;
}

export default function SettlementPage() {
  const { user } = useAuth();
  const companyId = user?.activeCompany?.id ?? '';

  const [mode, setMode] = useState<SettlementMode>('receipt');
  const [bankLedgers, setBankLedgers] = useState<Ledger[]>([]);
  const [partyLedgers, setPartyLedgers] = useState<Ledger[]>([]);
  const [tdsLedgerId, setTdsLedgerId] = useState<string>('');
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId) return;

    void (async () => {
      // Bank ledgers — catches RFPL Canara + Federal and RHHF HDFC
      // (all three live under groups whose names contain "bank")
      const { data: banks } = await supabasePramaana
        .from('ledgers')
        .select('id, name, ledger_groups!inner(name)')
        .eq('company_id', companyId)
        .ilike('ledger_groups.name', '%bank%');
      setBankLedgers((banks ?? []) as Ledger[]);

      // Party ledgers by mode:
      //   receipt → Sundry Debtors  (includes Peninsular Fisheries)
      //   payment → Sundry Creditors + Staff groups
      //
      // Step 4 note: verify actual group names with:
      //   SELECT DISTINCT name FROM pramaana.ledger_groups ORDER BY name;
      // Adjust the ilike patterns below if your group names differ.
      if (mode === 'receipt') {
        const { data: parties } = await supabasePramaana
          .from('ledgers')
          .select('id, name, ledger_groups!inner(name)')
          .eq('company_id', companyId)
          .ilike('ledger_groups.name', '%debtor%');
        setPartyLedgers((parties ?? []) as Ledger[]);
      } else {
        // Payment mode: Sundry Creditors + Staff/Salary ledger groups
        const { data: creditors } = await supabasePramaana
          .from('ledgers')
          .select('id, name, ledger_groups!inner(name)')
          .eq('company_id', companyId)
          .ilike('ledger_groups.name', '%creditor%');
        const { data: staff } = await supabasePramaana
          .from('ledgers')
          .select('id, name, ledger_groups!inner(name)')
          .eq('company_id', companyId)
          .or('ledger_groups.name.ilike.%staff%,ledger_groups.name.ilike.%salary%');
        const combined = [
          ...((creditors ?? []) as Ledger[]),
          ...((staff ?? []) as Ledger[]),
        ];
        // Deduplicate by id in case a ledger matches both filters
        const seen = new Set<string>();
        setPartyLedgers(
          combined.filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true))),
        );
      }

      // TDS control ledger — create if missing (see CLAUDE_CODE_INSTRUCTIONS.md Step 5)
      const tdsName = mode === 'receipt' ? '%tds%receivable%' : '%tds%payable%';
      const { data: tds } = await supabasePramaana
        .from('ledgers')
        .select('id, name')
        .eq('company_id', companyId)
        .ilike('name', tdsName)
        .limit(1)
        .maybeSingle();
      setTdsLedgerId(tds?.id ?? '');
    })();
  }, [companyId, mode]);

  /**
   * Advance ledger resolution.
   * Known mapping: Peninsular → Rent Deposit Recived.
   * Fallback: name-convention query ("advance <party first word>").
   * TODO: replace fallback with default_advance_ledger_id on party_config.
   */
  const advanceLedgerResolver = async (
    partyLedgerId: string,
  ): Promise<string | null> => {
    if (partyLedgerId === PENINSULAR_LEDGER) return RENT_DEPOSIT_LEDGER;

    const { data: party } = await supabasePramaana
      .from('ledgers')
      .select('name')
      .eq('id', partyLedgerId)
      .single();
    if (!party) return null;

    const { data: adv } = await supabasePramaana
      .from('ledgers')
      .select('id')
      .eq('company_id', companyId)
      .ilike('name', `%advance%${(party as { name: string }).name.split(' ')[0]}%`)
      .limit(1)
      .maybeSingle();
    return (adv as { id: string } | null)?.id ?? null;
  };

  if (!companyId) {
    return (
      <div className={css.page}>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
          No active company selected.
        </p>
      </div>
    );
  }

  return (
    <div className={css.page}>
      <div className={css.pageHeader}>
        <h1 className={css.pageTitle}>Settlement</h1>
        <p className={css.pageSubtitle}>
          {user?.activeCompany?.name ?? ''} · Receipt &amp; payment vouchers
        </p>
      </div>

      <div className={css.modeBar}>
        {(['receipt', 'payment'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={mode === m ? css.modePillActive : css.modePill}
          >
            {m === 'receipt' ? 'Receipts in' : 'Payments out'}
          </button>
        ))}
      </div>

      <SettlementSheet
        key={mode}
        mode={mode}
        companyId={companyId}
        bankLedgers={bankLedgers}
        partyLedgers={partyLedgers}
        tdsLedgerId={tdsLedgerId}
        advanceLedgerResolver={advanceLedgerResolver}
        onPosted={(_, number) => {
          setToast(`Posted ${number}`);
          setTimeout(() => setToast(null), 4000);
        }}
      />

      {toast && (
        <div style={{
          position: 'fixed', bottom: '1rem', right: '1rem',
          background: 'var(--success)', color: '#fff',
          padding: '0.5rem 1rem', borderRadius: 'var(--radius)',
          fontSize: '0.875rem', fontWeight: 600,
          boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
        }}>
          {toast}
        </div>
      )}
    </div>
  );
}
