import { supabasePramaana } from './supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BankFormatConfig {
  id: string
  bank_code: string
  bank_ledger_id: string
  company_id: string
  file_type: 'csv' | 'xlsx' | 'json'
  active: boolean
  match_day_window: number
}

export interface BankStatement {
  id: string
  company_id: string
  bank_format_id: string
  storage_path: string
  period_from: string
  period_to: string
  opening_balance: number | null
  closing_balance: number | null
  line_count: number | null
  parse_error: string | null
  status: 'uploaded' | 'parsed' | 'matched' | 'reviewed' | 'finalized'
  uploaded_at: string
  bank_format_config?: { bank_code: string }
}

export interface BankStatementLine {
  id: string
  statement_id: string
  company_id: string
  line_no: number
  txn_date: string
  value_date: string | null
  narration: string | null
  ref_no: string | null
  debit: number
  credit: number
  running_balance: number | null
  match_status: string
  matched_voucher_id: string | null
  match_group_id: string | null
  match_pass: number | null
  match_note: string | null
}

export interface AuditQuery {
  id: string
  company_id: string
  query_no: string
  raised_by: string
  context_type: string
  status: string
  subject: string
  created_at: string
  closed_at: string | null
}

export interface AuditQueryMessage {
  id: string
  query_id: string
  author_id: string
  body: string
  attachment_path: string | null
  created_at: string
}

export interface BrsResult {
  book_balance: number
  less_uncleared_cheques: number
  add_deposits_in_transit: number
  add_unbooked_credits: number
  less_unbooked_debits: number
  derived_bank_balance: number
  statement_closing_balance: number | null
  variance: number
}

// ── Data fetchers ─────────────────────────────────────────────────────────────

export async function fetchBankFormats(companyId: string): Promise<BankFormatConfig[]> {
  const { data, error } = await supabasePramaana
    .from('bank_format_config')
    .select('id, bank_code, bank_ledger_id, company_id, file_type, active, match_day_window')
    .eq('company_id', companyId)
    .order('bank_code')
  if (error) throw error
  return (data ?? []) as BankFormatConfig[]
}

export async function fetchStatements(companyId: string): Promise<BankStatement[]> {
  const { data, error } = await supabasePramaana
    .from('bank_statements')
    .select('*, bank_format_config(bank_code)')
    .eq('company_id', companyId)
    .order('uploaded_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as BankStatement[]
}

export async function fetchStatementLines(
  statementId: string,
  statusFilter?: string[],
): Promise<BankStatementLine[]> {
  let q = supabasePramaana
    .from('bank_statement_lines')
    .select('*')
    .eq('statement_id', statementId)
    .order('line_no')

  if (statusFilter?.length) {
    q = q.in('match_status', statusFilter)
  }
  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as BankStatementLine[]
}

export async function fetchQueriesForStatement(
  companyId: string,
  statementId: string,
): Promise<AuditQuery[]> {
  // Get queries linked to lines in this statement
  const { data, error } = await supabasePramaana
    .from('audit_queries')
    .select(`
      id, company_id, query_no, raised_by, context_type, status, subject, created_at, closed_at,
      audit_query_items!inner(line_id, audit_query_items_line:bank_statement_lines!inner(statement_id))
    `)
    .eq('company_id', companyId)
    .eq('audit_query_items.audit_query_items_line.statement_id', statementId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as AuditQuery[]
}

export async function fetchQueryMessages(queryId: string): Promise<AuditQueryMessage[]> {
  const { data, error } = await supabasePramaana
    .from('audit_query_messages')
    .select('*')
    .eq('query_id', queryId)
    .order('created_at')
  if (error) throw error
  return (data ?? []) as AuditQueryMessage[]
}

export async function confirmMatch(lineId: string): Promise<void> {
  const { error } = await supabasePramaana
    .from('bank_statement_lines')
    .update({ match_status: 'confirmed' })
    .eq('id', lineId)
    .in('match_status', ['fuzzy_matched'])
  if (error) throw error
}

export async function markIgnored(lineId: string, note: string): Promise<void> {
  const { error } = await supabasePramaana
    .from('bank_statement_lines')
    .update({ match_status: 'ignored', match_note: note })
    .eq('id', lineId)
  if (error) throw error
}

export async function unlinkMatch(lineId: string): Promise<void> {
  const { error } = await supabasePramaana
    .from('bank_statement_lines')
    .update({
      match_status:       'unmatched',
      matched_voucher_id: null,
      match_group_id:     null,
      match_pass:         null,
      match_note:         null,
    })
    .eq('id', lineId)
  if (error) throw error
}

export async function getBrs(
  bankLedgerId: string,
  asOf: string,
  companyId: string,
): Promise<BrsResult> {
  const { data, error } = await supabasePramaana.rpc('get_brs', {
    p_bank_ledger_id: bankLedgerId,
    p_as_of:          asOf,
    p_company_id:     companyId,
  })
  if (error) throw error
  return data as BrsResult
}
