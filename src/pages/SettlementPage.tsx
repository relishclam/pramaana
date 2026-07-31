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
      <div className="p-4 text-sm text-neutral-500">
        No active company selected.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-4">
      {/* Mode toggle */}
      <div className="mb-4 inline-flex rounded-lg border border-neutral-300 p-0.5">
        {(['receipt', 'payment'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium ${
              mode === m
                ? 'bg-blue-600 text-white'
                : 'text-neutral-600 hover:bg-neutral-100'
            }`}
          >
            {m === 'receipt' ? 'Receipts in' : 'Payments out'}
          </button>
        ))}
      </div>

      <SettlementSheet
        key={mode} /* remount on mode switch to reset state */
        mode={mode}
        companyId={companyId}
        bankLedgers={bankLedgers}
        partyLedgers={partyLedgers}
        tdsLedgerId={tdsLedgerId}
        advanceLedgerResolver={advanceLedgerResolver}
        /* Peninsular rent: GST-inclusive → base = total / 1.18 (default).
           For salary settlements pass tdsBaseDivisor={1}. */
        onPosted={(_, number) => {
          setToast(`Posted ${number}`);
          setTimeout(() => setToast(null), 4000);
        }}
      />

      {toast && (
        <div className="fixed bottom-4 right-4 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
