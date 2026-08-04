/**
 * GET  /api/bank-recon-brs?company_id=...&bank_account_id=...&as_at_date=YYYY-MM-DD
 * Computes and returns a Bank Reconciliation Statement.
 */
export const config = { runtime: 'edge' }

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } })

function env(k: string): string {
  const proc = (globalThis as Record<string, unknown>)['process'] as
    { env?: Record<string, string | undefined> } | undefined
  return proc?.env?.[k] ?? ''
}

async function dbGet(url: string, key: string, path: string): Promise<unknown[]> {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Accept-Profile': 'pramaana' },
  })
  return res.ok ? res.json() as Promise<unknown[]> : []
}

interface ReconItem {
  txn_date: string
  narration: string
  amount: number
  voucher_id: string | null
  bank_txn_id: string | null
}

export async function GET(req: Request): Promise<Response> {
  try { return await handleRequest(req) } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('bank-recon-brs crash:', msg)
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

async function handleRequest(req: Request): Promise<Response> {
  const supabaseUrl = env('VITE_SUPABASE_URL')
  const serviceKey  = env('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) return json({ error: 'Server not configured' }, 500)

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 403)
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: authHeader },
  })
  if (!userRes.ok) return json({ error: 'Unauthorized' }, 403)

  const params = new URL(req.url).searchParams
  const companyId    = params.get('company_id')
  const bankAccountId = params.get('bank_account_id')
  const asAtDate     = params.get('as_at_date')

  if (!companyId || !bankAccountId || !asAtDate) {
    return json({ error: 'company_id, bank_account_id, and as_at_date required' }, 400)
  }

  // Get bank account + ledger link
  const accounts = (await dbGet(supabaseUrl, serviceKey,
    `recon_bank_accounts?id=eq.${bankAccountId}&company_id=eq.${companyId}&select=ledger_id,bank_name,account_number`)) as { ledger_id: string | null; bank_name: string; account_number: string }[]

  if (!accounts.length) return json({ error: 'Bank account not found' }, 404)
  const account = accounts[0]

  // ── Balance per bank (last statement closing balance on or before asAtDate) ─
  const statements = (await dbGet(supabaseUrl, serviceKey,
    `recon_statements?bank_account_id=eq.${bankAccountId}&period_to=lte.${asAtDate}&order=period_to.desc&limit=1&select=closing_balance`)) as { closing_balance: number }[]
  const balancePerBank = statements[0]?.closing_balance ?? 0

  // ── Balance per books (ledger running balance as at asAtDate) ─────────────
  let balancePerBooks = 0
  if (account.ledger_id) {
    const entries = (await dbGet(supabaseUrl, serviceKey,
      `voucher_entries?ledger_id=eq.${account.ledger_id}` +
      `&vouchers.voucher_date=lte.${asAtDate}&vouchers.status=eq.posted` +
      `&select=debit,credit,vouchers!inner(voucher_date,status)`)) as { debit: number | null; credit: number | null }[]
    const totalDebits  = entries.reduce((s, e) => s + (e.debit  ?? 0), 0)
    const totalCredits = entries.reduce((s, e) => s + (e.credit ?? 0), 0)
    balancePerBooks = Math.round((totalDebits - totalCredits) * 100) / 100
  }

  // ── Unmatched bank transactions (bank side, no book entry) ────────────────
  const unmatchedBankTxns = (await dbGet(supabaseUrl, serviceKey,
    `recon_transactions?bank_account_id=eq.${bankAccountId}` +
    `&txn_date=lte.${asAtDate}&match_status=in.(unmatched)&select=id,txn_date,narration,debit,credit`)) as { id: string; txn_date: string; narration: string; debit: number | null; credit: number | null }[]

  const bankDebitsNotInBooks: ReconItem[] = unmatchedBankTxns
    .filter(t => t.debit !== null)
    .map(t => ({ txn_date: t.txn_date, narration: t.narration, amount: t.debit!, voucher_id: null, bank_txn_id: t.id }))

  const bankCreditsNotInBooks: ReconItem[] = unmatchedBankTxns
    .filter(t => t.credit !== null)
    .map(t => ({ txn_date: t.txn_date, narration: t.narration, amount: t.credit!, voucher_id: null, bank_txn_id: t.id }))

  // ── Unconfirmed/book-side-only items ──────────────────────────────────────
  const chequesIssuedNotPresented: ReconItem[] = []   // book Dr, not in bank
  const chequesDepositedNotCleared: ReconItem[] = []  // book Cr, not in bank

  // Compute adjusted balances
  const addCredits  = bankCreditsNotInBooks.reduce((s, i) => s + i.amount, 0)
  const lessDebits  = bankDebitsNotInBooks.reduce((s, i)  => s + i.amount, 0)
  const lessCheques = chequesIssuedNotPresented.reduce((s, i) => s + i.amount, 0)
  const addDeposits = chequesDepositedNotCleared.reduce((s, i) => s + i.amount, 0)

  const adjustedBankBalance = Math.round(
    (balancePerBank + addCredits - lessDebits - lessCheques + addDeposits) * 100
  ) / 100
  const adjustedBookBalance = Math.round(balancePerBooks * 100) / 100
  const difference = Math.round((adjustedBankBalance - adjustedBookBalance) * 100) / 100

  return json({
    as_at_date:                    asAtDate,
    bank_name:                     account.bank_name,
    account_number:                account.account_number,
    balance_per_books:             balancePerBooks,
    balance_per_bank:              balancePerBank,
    cheques_issued_not_presented:  chequesIssuedNotPresented,
    cheques_deposited_not_cleared: chequesDepositedNotCleared,
    bank_credits_not_in_books:     bankCreditsNotInBooks,
    bank_debits_not_in_books:      bankDebitsNotInBooks,
    adjusted_book_balance:         adjustedBookBalance,
    adjusted_bank_balance:         adjustedBankBalance,
    is_reconciled:                 Math.abs(difference) < 0.01,
    difference,
  })
}
