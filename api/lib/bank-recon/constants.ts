import type { BankSignature } from './types.js'

export const BANK_SIGNATURES: Record<string, BankSignature> = {
  HDFC: {
    code: 'HDFC',
    name: 'HDFC Bank',
    header_patterns: [
      ['Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
    ],
    metadata_patterns: [
      /HDFC\s*BANK/i,
      /IFSC\s*:?\s*HDFC\d/i,
    ],
    narration_markers: ['UPI-', 'NEFT CR-', 'NEFT DR-', 'POS 514834', 'RTGS CR-', 'RTGS DR-', 'ATM-CASH WDL'],
    date_formats: ['DD/MM/YY', 'DD/MM/YYYY'],
    number_format: 'international',
  },

  CANARA: {
    code: 'CANARA',
    name: 'Canara Bank',
    header_patterns: [
      ['Txn Date', 'Value Date', 'Cheque No.', 'Description', 'Branch Code', 'Debit', 'Credit', 'Balance'],
    ],
    metadata_patterns: [
      /CANARA\s*BANK/i,
    ],
    narration_markers: ['IB-IMPS-DR//', 'ATM Cash-', 'MOB-IMPS-CR/', 'IB ITG', 'RTGS Cr-'],
    date_formats: ['DD-MM-YYYY HH:mm:ss', 'DD Mon YYYY', 'DD-MM-YYYY'],
    number_format: 'indian',
    excel_quoted: true,
  },

  FEDERAL: {
    code: 'FEDERAL',
    name: 'Federal Bank',
    header_patterns: [
      // Real header has an empty column between Particulars and Value Date
      // Matcher skips empty-header columns so indices don't shift
      ['Sl. No.', 'Tran Date', 'Particulars', 'Value Date', 'Tran Type', 'Cheque Details', 'Withdrawal', 'Deposit', 'Balance Amount'],
    ],
    metadata_patterns: [
      /FEDERAL\s*BANK/i,
      /Account\s*Category:\s*FREEDOM/i,
    ],
    narration_markers: ['FN IMPS/IFO/', 'UPIOUT/', 'UPIIN/', 'FT IMPS/IFI/', 'CHRG/IMPS/'],
    date_formats: ['DD-MM-YYYY'],
    number_format: 'international',
    typical_sort: 'desc',
  },

  SIB: {
    code: 'SIB',
    name: 'South Indian Bank',
    header_patterns: [
      ['Transaction Date', 'Value Date', 'Description', 'Cheque No', 'Debit', 'Credit', 'Balance'],
    ],
    metadata_patterns: [
      /SOUTH\s*INDIAN\s*BANK/i,
    ],
    narration_markers: [],
    date_formats: ['DD-MM-YYYY', 'DD/MM/YYYY'],
    number_format: 'international',
  },

  ICICI: {
    code: 'ICICI',
    name: 'ICICI Bank',
    header_patterns: [
      ['S No.', 'Value Date', 'Transaction Date', 'Cheque Number', 'Transaction Remarks',
       'Withdrawal Amount (INR )', 'Deposit Amount (INR )', 'Balance (INR )'],
    ],
    metadata_patterns: [
      /ICICI\s*BANK/i,
    ],
    narration_markers: ['UPI/', 'NEFT-', 'RTGS-'],
    date_formats: ['DD/MM/YYYY'],
    number_format: 'international',
  },
}

// Row-level skip patterns — rows matching any of these are not data rows
export const GLOBAL_SKIP_PATTERNS = [
  /^\*+$/,               // ********
  /^-+$/,                // --------
  /^opening\s*balance/i,
  /^closing\s*balance/i,
  /^total\s*amount/i,
  /^grand\s*total/i,
  /^\s*$/,               // blank row
]

// Header column name normalisation — strip, lowercase, remove punctuation
export function normaliseHeaderCell(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}
