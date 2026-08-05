// ── Core interfaces for the Autonomous Bank Recon module ──────────────────────

export interface ColumnMapping {
  date_col: number
  value_date_col: number | null
  narration_col: number
  reference_col: number | null
  debit_col: number | null
  credit_col: number | null
  balance_col: number
  // Single-amount + Dr/Cr indicator banks
  amount_col: number | null
  dr_cr_col: number | null
  // Format metadata
  date_format: string
  number_format: 'indian' | 'international'
  header_row: number
  data_start_row: number
  skip_patterns: string[]
  excel_quoted: boolean
}

export interface CanonicalTransaction {
  row_number: number        // 1-indexed, chronological after sort-fix
  txn_date: string          // YYYY-MM-DD
  value_date: string | null
  narration: string
  reference: string | null
  debit: number | null      // NULL if credit
  credit: number | null     // NULL if debit
  balance: number
}

export interface ValidationResult {
  is_valid: boolean
  opening_balance: number
  closing_balance: number
  computed_closing: number
  total_debits: number
  total_credits: number
  balance_continuous: boolean
  discontinuities: { row: number; expected: number; actual: number }[]
  errors: string[]
}

export interface DuplicateGroup {
  key: string
  row_numbers: number[]
}

export interface OverlapInfo {
  existing_statement_id: string
  existing_period_from: string
  existing_period_to: string
  overlap_from: string
  overlap_to: string
  duplicate_txn_count: number
}

export interface BankDetectResult {
  bank_code: string
  bank_name: string
  confidence: number
  method: 'heuristic' | 'ai'
  account_number: string | null
  ifsc: string | null
  branch: string | null
}

export interface FormatDetectResult {
  mapping: ColumnMapping
  profile_id: string | null
  confidence: number
  method: 'profile_cache' | 'heuristic' | 'ai'
  format_signature: string
}

export interface PreConvertResult {
  bank: BankDetectResult
  format: FormatDetectResult
  transactions: CanonicalTransaction[]
  opening_balance: number
  closing_balance: number
  period_from: string
  period_to: string
  sort_detected: 'asc' | 'desc'
  validation: ValidationResult
  duplicates: DuplicateGroup[]
  overlap: OverlapInfo | null
  raw_rows: string[][]  // for format profile creation
}

export interface ParsedNarration {
  txn_type: 'UPI' | 'NEFT' | 'RTGS' | 'IMPS' | 'ATM' | 'POS' | 'CHEQUE' |
            'FD' | 'SWEEP' | 'CHARGE' | 'INTEREST' | 'GST' | 'SALARY' | 'OTHER'
  counterparty: string | null
  counterparty_account: string | null
  parsed_reference: string | null
  parsed_purpose: string | null
  is_charge: boolean
  is_reversal: boolean
}

export interface BankSignature {
  code: string
  name: string
  header_patterns: string[][]
  metadata_patterns: RegExp[]
  narration_markers: string[]
  date_formats: string[]
  number_format: 'indian' | 'international'
  excel_quoted?: boolean
  typical_sort?: 'asc' | 'desc'
}

// Upload API request/response shapes
export interface UploadRequest {
  company_id: string
  file_base64: string
  file_name: string
  file_type: string
  bank_code?: string
  overlap_resolution?: 'skip_duplicates' | 'replace' | 'merge'
  storage_path?: string  // set on second POST when resolving overlap
}

export type UploadStatus =
  | 'success'
  | 'needs_bank_selection'
  | 'overlap_detected'
  | 'validation_warning'
  | 'error'

export interface UploadResponse {
  status: UploadStatus
  statement_id?: string
  summary?: {
    bank: { code: string; name: string; confidence: number }
    account_number: string | null
    period_from: string
    period_to: string
    txn_count: number
    debit_count: number
    credit_count: number
    total_debits: number
    total_credits: number
    opening_balance: number
    closing_balance: number
  }
  match_result?: {
    exact_matches: number
    fuzzy_matches: number
    ai_matches: number
    unmatched: number
    queries_created: number
  }
  validation?: ValidationResult
  overlap?: OverlapInfo
  bank_candidates?: { code: string; name: string; confidence: number }[]
  error?: string
  // On overlap_detected: the raw file has been stored here
  storage_path?: string
}

export interface MatchResult {
  bank_txn_id: string
  voucher_id: string | null
  voucher_entry_id: string | null
  match_method: 'exact' | 'reference' | 'fuzzy' | 'ai' | 'manual'
  match_confidence: number
  match_reason: string
  company_id: string
  matched_by?: string | null   // auth.users.id — null for auto matches, set on confirm
}

export interface MatchEngineResult {
  exact_matches: number
  fuzzy_matches: number
  ai_matches: number
  unmatched: number
  queries_created: number
}

// AI format detection result (from Claude API)
export interface AIFormatResult {
  bank_code: string
  bank_name: string
  account_number: string | null
  ifsc: string | null
  header_row: number
  data_start_row: number
  columns: {
    date: number
    value_date: number | null
    narration: number
    reference: number | null
    debit: number | null
    credit: number | null
    balance: number
    amount: number | null
    dr_cr_indicator: number | null
  }
  date_format: string
  sort_order: 'asc' | 'desc'
  number_format: 'indian' | 'international'
  excel_quoted: boolean
  skip_patterns: string[]
}

export interface AIParsedNarration extends ParsedNarration {
  index: number
}

export interface AIMatchSuggestion {
  bank_txn_id: string
  voucher_id: string | null
  confidence: number
  reason: string
}
