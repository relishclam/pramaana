/**
 * POST /api/bank-recon-upload
 *
 * Two-round-trip flow:
 *   Round 1: parse file, detect bank, check overlap → return result
 *   Round 2: if overlap_detected, client sends { storage_path, overlap_resolution }
 *             → re-parse from storage, commit to DB, run match engine
 *
 * Body (Round 1): { company_id, file_base64, file_name, file_type, bank_code? }
 * Body (Round 2): { company_id, storage_path, overlap_resolution, file_name, file_type }
 */

export const config = { runtime: 'nodejs' }  // xlsx needs Node, not Edge

import { runPreConverter } from './lib/bank-recon/pre-converter.js'
import { runMatchEngine }  from './lib/bank-recon/match-engine.js'
import { parseNarration }  from './lib/bank-recon/narration-parser.js'
import { aiParseNarrations } from './lib/bank-recon/ai-narration-parse.js'
import type { UploadRequest, UploadResponse, CanonicalTransaction, ColumnMapping } from './lib/bank-recon/types.js'
import { createHash } from 'crypto'

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

function env(k: string): string {
  return process.env[k] ?? ''
}

export default async function handler(req: Request): Promise<Response> {
  try {
    return await handleRequest(req)
  } catch (e) {
    // Surface the real error instead of Vercel's generic FUNCTION_INVOCATION_FAILED
    const msg = e instanceof Error ? e.message : String(e)
    const stack = e instanceof Error ? e.stack : undefined
    console.error('bank-recon-upload crash:', msg, stack)
    return json({ status: 'error', error: msg }, 500)
  }
}

async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const supabaseUrl = env('VITE_SUPABASE_URL')
  const serviceKey  = env('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) return json({ error: 'Server not configured' }, 500)

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 403)

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: authHeader },
  })
  if (!userRes.ok) return json({ error: 'Unauthorized' }, 403)
  const { id: userId } = await userRes.json() as { id: string }

  let body: UploadRequest
  try { body = await req.json() as UploadRequest } catch { return json({ error: 'Invalid JSON' }, 400) }

  const { company_id } = body
  if (!company_id) return json({ error: 'company_id required' }, 400)

  // Verify company membership
  const cuRes = await dbGet(supabaseUrl, serviceKey,
    `company_users?user_id=eq.${userId}&company_id=eq.${company_id}&select=role`,
    'registry')
  if (!cuRes.length) return json({ error: 'Access denied' }, 403)

  // ── Round 2: resolve overlap with stored file ─────────────────────────────
  if (body.storage_path && body.overlap_resolution) {
    return handleOverlapResolution(body, userId, supabaseUrl, serviceKey)
  }

  // ── Round 1: parse fresh upload ───────────────────────────────────────────
  if (!body.file_base64 || !body.file_name) {
    return json({ error: 'file_base64 and file_name required' }, 400)
  }

  const rawBytes = Buffer.from(body.file_base64, 'base64')

  // Duplicate check by SHA-256 hash
  const fileHash = createHash('sha256').update(rawBytes).digest('hex')
  const existing = await dbGet(supabaseUrl, serviceKey,
    `recon_statements?company_id=eq.${company_id}&file_hash=eq.${fileHash}&select=id`)
  if (existing.length) {
    return json({
      status: 'error',
      error:  `This file was already uploaded (statement ${(existing[0] as { id: string }).id})`,
      statement_id: (existing[0] as { id: string }).id,
    }, 409)
  }

  // Run pre-converter
  let preResult
  try {
    // Load format profiles for cache lookup
    const profiles = await loadFormatProfiles(supabaseUrl, serviceKey, body.bank_code)
    preResult = await runPreConverter(
      new Uint8Array(rawBytes),
      body.file_name,
      { forceBankCode: body.bank_code, formatProfiles: profiles },
    )
  } catch (e) {
    return json({ status: 'error', error: e instanceof Error ? e.message : 'Parse failed' }, 400)
  }

  // If bank not detected
  if (!preResult.bank.bank_code || preResult.bank.confidence < 50) {
    // Store file temporarily for retry after user selects bank
    const storagePath = await storeRawFile(supabaseUrl, serviceKey, company_id, rawBytes, body.file_name)
    return json({
      status:          'needs_bank_selection',
      storage_path:    storagePath,
      bank_candidates: [],
    } as UploadResponse)
  }

  // Store raw file in all cases (needed for overlap re-parse)
  const storagePath = await storeRawFile(supabaseUrl, serviceKey, company_id, rawBytes, body.file_name)

  // Check for overlap with existing statements for this bank account
  const overlap = await checkOverlap(
    supabaseUrl, serviceKey, company_id,
    preResult.bank.bank_code,
    preResult.bank.account_number ?? 'UNKNOWN',
    preResult.period_from,
    preResult.period_to,
  )

  if (overlap) {
    return json({
      status:       'overlap_detected',
      storage_path: storagePath,
      overlap,
      options:      ['skip_duplicates', 'replace', 'merge'],
      summary: buildSummary(preResult),
    } as UploadResponse)
  }

  // Validation warning — return it but still commit (advisory only)
  const validationWarning = !preResult.validation.is_valid

  const t0 = Date.now()
  const mark = (stage: string) => console.log(`[upload] ${stage} +${Date.now() - t0}ms`)

  // ── Commit to database ────────────────────────────────────────────────────
  const statementId = await commitStatement({
    supabaseUrl, serviceKey, company_id, userId, preResult,
    fileHash, storagePath, fileName: body.file_name,
    overlapResolution: null,
  })
  mark('committed')

  // Fetch bank account once — needed by both enrichNarrations and the match engine
  const bankAccount = await getBankAccount(supabaseUrl, serviceKey, company_id,
    preResult.bank.bank_code, preResult.bank.account_number ?? 'UNKNOWN')

  await enrichNarrations(supabaseUrl, serviceKey, statementId, company_id, bankAccount?.id ?? '', preResult.transactions)
  mark('enriched')

  // ── Match engine ─────────────────────────────────────────────────────
  let matchResult = { exact_matches: 0, fuzzy_matches: 0, ai_matches: 0, unmatched: preResult.transactions.length, queries_created: 0 }
  if (bankAccount?.ledger_id) {
    matchResult = await runMatchEngine(statementId, company_id, bankAccount.ledger_id, supabaseUrl, serviceKey)
  }
  mark('matched')

  const response: UploadResponse = {
    status:       validationWarning ? 'validation_warning' : 'success',
    statement_id: statementId,
    summary:      buildSummary(preResult),
    match_result: matchResult,
    ...(validationWarning ? { validation: preResult.validation } : {}),
  }
  return json(response)
}

// ── Overlap resolution (Round 2) ──────────────────────────────────────────────

async function handleOverlapResolution(
  body: UploadRequest,
  userId: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<Response> {
  const { company_id, storage_path, overlap_resolution, file_name } = body
  if (!storage_path || !company_id || !file_name) {
    return json({ error: 'storage_path, company_id, file_name required for overlap resolution' }, 400)
  }

  // Re-download raw file from storage
  const rawBytes = await downloadRawFile(supabaseUrl, serviceKey, storage_path)
  if (!rawBytes) return json({ error: 'Stored file not found' }, 404)

  const profiles = await loadFormatProfiles(supabaseUrl, serviceKey)
  let preResult
  try {
    preResult = await runPreConverter(new Uint8Array(rawBytes), file_name, { formatProfiles: profiles })
  } catch (e) {
    return json({ status: 'error', error: e instanceof Error ? e.message : 'Parse failed' }, 400)
  }

  const fileHash = createHash('sha256').update(rawBytes).digest('hex')

  // ── Apply overlap resolution before committing ────────────────────────────
  if (overlap_resolution === 'replace') {
    const account = await getBankAccount(supabaseUrl, serviceKey, company_id,
      preResult.bank.bank_code, preResult.bank.account_number ?? 'UNKNOWN')
    if (account) {
      const overlapping = (await dbGet(supabaseUrl, serviceKey,
        `recon_statements?bank_account_id=eq.${account.id}` +
        `&period_from=lte.${preResult.period_to}&period_to=gte.${preResult.period_from}&select=id`
      )) as { id: string }[]
      for (const s of overlapping) {
        await dbDelete(supabaseUrl, serviceKey, `recon_statements?id=eq.${s.id}`)
      }
    }
  }

  // merge = skip_duplicates for v1 (keep existing confirmed work, add only new transactions)
  if (overlap_resolution === 'skip_duplicates' || overlap_resolution === 'merge') {
    const account = await getBankAccount(supabaseUrl, serviceKey, company_id,
      preResult.bank.bank_code, preResult.bank.account_number ?? 'UNKNOWN')
    if (account) {
      const existing = (await dbGet(supabaseUrl, serviceKey,
        `recon_transactions?bank_account_id=eq.${account.id}` +
        `&txn_date=gte.${preResult.period_from}&txn_date=lte.${preResult.period_to}` +
        `&select=txn_date,debit,credit,narration`
      )) as { txn_date: string; debit: number | null; credit: number | null; narration: string }[]
      const existingKeys = new Set(existing.map(e => `${e.txn_date}|${e.debit}|${e.credit}|${e.narration}`))
      preResult = {
        ...preResult,
        transactions: preResult.transactions.filter(
          t => !existingKeys.has(`${t.txn_date}|${t.debit}|${t.credit}|${t.narration}`)
        ),
      }
    }
  }

  const statementId = await commitStatement({
    supabaseUrl, serviceKey, company_id, userId, preResult,
    fileHash, storagePath: storage_path, fileName: file_name,
    overlapResolution: overlap_resolution ?? null,
  })

  const bankAccount = await getBankAccount(supabaseUrl, serviceKey, company_id,
    preResult.bank.bank_code, preResult.bank.account_number ?? 'UNKNOWN')

  await enrichNarrations(supabaseUrl, serviceKey, statementId, company_id, bankAccount?.id ?? '', preResult.transactions)

  let matchResult = { exact_matches: 0, fuzzy_matches: 0, ai_matches: 0, unmatched: preResult.transactions.length, queries_created: 0 }
  if (bankAccount?.ledger_id) {
    matchResult = await runMatchEngine(statementId, company_id, bankAccount.ledger_id, supabaseUrl, serviceKey)
  }

  return json({
    status:       'success',
    statement_id: statementId,
    summary:      buildSummary(preResult),
    match_result: matchResult,
  } as UploadResponse)
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function dbGet(url: string, key: string, path: string, schema = 'pramaana'): Promise<unknown[]> {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: {
      apikey:           key,
      Authorization:    `Bearer ${key}`,
      'Accept-Profile': schema,
    },
  })
  if (!res.ok) return []
  return res.json() as Promise<unknown[]>
}

async function dbPost(url: string, key: string, path: string, body: unknown, schema = 'pramaana'): Promise<{ id: string }[]> {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey:            key,
      Authorization:     `Bearer ${key}`,
      'Content-Type':    'application/json',
      'Accept-Profile':  schema,
      'Content-Profile': schema,
      Prefer:            'return=representation',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`DB error ${res.status}: ${err}`)
  }
  return res.json() as Promise<{ id: string }[]>
}

async function dbDelete(url: string, key: string, path: string, schema = 'pramaana'): Promise<void> {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: {
      apikey:            key,
      Authorization:     `Bearer ${key}`,
      'Accept-Profile':  schema,
      'Content-Profile': schema,
    },
  })
  if (!res.ok) console.error(`DB DELETE error ${res.status} on ${path}:`, await res.text())
}

async function dbPatch(url: string, key: string, path: string, body: unknown, schema = 'pramaana'): Promise<void> {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey:            key,
      Authorization:     `Bearer ${key}`,
      'Content-Type':    'application/json',
      'Accept-Profile':  schema,
      'Content-Profile': schema,
      Prefer:            'return=minimal',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.text()
    console.error(`DB PATCH error ${res.status} on ${path}:`, err)
  }
}

// ── Commit statement + transactions to DB ─────────────────────────────────────

async function commitStatement(opts: {
  supabaseUrl: string
  serviceKey: string
  company_id: string
  userId: string
  preResult: Awaited<ReturnType<typeof runPreConverter>>
  fileHash: string
  storagePath: string
  fileName: string
  overlapResolution: string | null
}): Promise<string> {
  const { supabaseUrl, serviceKey, company_id, userId, preResult, fileHash, storagePath, fileName } = opts

  // Upsert bank account
  const bankAccount = await upsertBankAccount(
    supabaseUrl, serviceKey, company_id,
    preResult.bank.bank_code,
    preResult.bank.bank_name,
    preResult.bank.account_number ?? 'UNKNOWN',
    preResult.bank.ifsc,
  )

  // Upsert format profile
  const profileId = await upsertFormatProfile(
    supabaseUrl, serviceKey,
    preResult.bank.bank_code,
    preResult.format.format_signature,
    preResult.format.mapping,
    preResult.raw_rows[preResult.format.mapping.header_row] ?? [],
    preResult.format.method === 'ai' ? 'ai' : 'heuristic',
  )

  // Insert statement
  const v = preResult.validation
  const [stmt] = await dbPost(supabaseUrl, serviceKey, 'recon_statements', {
    company_id,
    bank_account_id:  bankAccount.id,
    period_from:      preResult.period_from,
    period_to:        preResult.period_to,
    opening_balance:  preResult.opening_balance,
    closing_balance:  preResult.closing_balance,
    total_debits:     v.total_debits,
    total_credits:    v.total_credits,
    txn_count:        preResult.transactions.length,
    debit_count:      preResult.transactions.filter(t => t.debit !== null).length,
    credit_count:     preResult.transactions.filter(t => t.credit !== null).length,
    sort_order:       preResult.sort_detected,
    format_profile_id: profileId,
    file_name:        fileName,
    file_hash:        fileHash,
    storage_path:     storagePath,
    upload_status:    'parsed',
    uploaded_by:      userId,
  })

  const statementId = stmt.id

  // Batch insert transactions enriched with heuristic narration parse inline
  // (avoids a separate N-round-trip enrichment pass after insert)
  const CHUNK = 500
  for (let i = 0; i < preResult.transactions.length; i += CHUNK) {
    const chunk = preResult.transactions.slice(i, i + CHUNK).map(t => {
      const parsed = parseNarration(t.narration)
      return {
        statement_id:         statementId,
        company_id,
        bank_account_id:      bankAccount.id,
        row_number:           t.row_number,
        txn_date:             t.txn_date,
        value_date:           t.value_date,
        narration:            t.narration,
        reference:            t.reference,
        debit:                t.debit,
        credit:               t.credit,
        balance:              t.balance,
        match_status:         'unmatched',
        txn_type:             parsed.txn_type,
        counterparty:         parsed.counterparty,
        counterparty_account: parsed.counterparty_account,
        parsed_reference:     parsed.parsed_reference,
        parsed_purpose:       parsed.parsed_purpose,
        is_charge:            parsed.is_charge,
        is_reversal:          parsed.is_reversal,
      }
    })
    await dbPost(supabaseUrl, serviceKey, 'recon_transactions', chunk)
  }

  return statementId
}

// ── Narration enrichment — AI pass only (heuristic is done inline at insert) ──

async function enrichNarrations(
  supabaseUrl: string,
  serviceKey: string,
  statementId: string,
  companyId: string,
  bankAccountId: string,
  transactions: CanonicalTransaction[],
): Promise<void> {
  // Only the narrations the heuristic couldn't classify need AI enrichment
  const unknowns = transactions
    .filter(t => {
      const p = parseNarration(t.narration)
      return p.txn_type === 'OTHER'
    })
    .map(t => ({ index: t.row_number, text: t.narration }))

  if (!unknowns.length) return

  // Load the DB-assigned IDs for the 'OTHER' rows
  const rowNumbers = unknowns.map(u => u.index).join(',')
  const txnRows = (await dbGet(supabaseUrl, serviceKey,
    `recon_transactions?statement_id=eq.${statementId}&row_number=in.(${rowNumbers})&select=id,row_number`
  )) as { id: string; row_number: number }[]

  const idByRow = new Map(txnRows.map(r => [r.row_number, r.id]))
  const txnByRow = new Map(transactions.map(t => [t.row_number, t]))

  // AI enrichment — capped at 4 batches (200 narrations) per upload to bound latency
  const BATCH = 50
  const MAX_AI_BATCHES = 4
  const AI_BATCH_TIMEOUT = 25_000
  const aiUpdates: { id: string; row_number: number; fields: Record<string, unknown> }[] = []

  for (let i = 0; i < unknowns.length && i < BATCH * MAX_AI_BATCHES; i += BATCH) {
    const batch = unknowns.slice(i, i + BATCH)
    // Race each batch against a timeout — timed-out batches stay 'OTHER' (graceful degradation)
    const aiResults = await Promise.race([
      aiParseNarrations(batch),
      new Promise<[]>(r => setTimeout(() => r([]), AI_BATCH_TIMEOUT)),
    ])
    for (const ai of aiResults) {
      const id = idByRow.get(ai.index)
      if (!id) continue
      aiUpdates.push({
        id,
        row_number: ai.index,
        fields: {
          txn_type:            ai.txn_type,
          counterparty:        ai.counterparty        ?? null,
          counterparty_account: ai.counterparty_account ?? null,
          parsed_reference:    ai.parsed_reference    ?? null,
          parsed_purpose:      ai.parsed_purpose      ?? null,
          is_charge:           ai.is_charge,
          is_reversal:         ai.is_reversal,
        },
      })
    }
  }

  if (!aiUpdates.length) return

  // Bulk upsert — must include all NOT NULL columns so INSERT is valid before conflict fires
  const CHUNK = 500
  for (let i = 0; i < aiUpdates.length; i += CHUNK) {
    const chunk = aiUpdates.slice(i, i + CHUNK).map(u => {
      const t = txnByRow.get(u.row_number)!
      return {
        id:                   u.id,
        statement_id:         statementId,
        company_id:           companyId,
        bank_account_id:      bankAccountId,
        row_number:           t.row_number,
        txn_date:             t.txn_date,
        value_date:           t.value_date,
        narration:            t.narration,
        reference:            t.reference,
        debit:                t.debit,
        credit:               t.credit,
        balance:              t.balance,
        match_status:         'unmatched',
        ...u.fields,
      }
    })
    const res = await fetch(`${supabaseUrl}/rest/v1/recon_transactions?on_conflict=id`, {
      method: 'POST',
      headers: {
        apikey:            serviceKey,
        Authorization:     `Bearer ${serviceKey}`,
        'Content-Type':    'application/json',
        'Accept-Profile':  'pramaana',
        'Content-Profile': 'pramaana',
        Prefer:            'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(chunk),
    })
    if (!res.ok) console.error('AI enrichment upsert error:', res.status, await res.text())
  }
}

// ── Bank account upsert ───────────────────────────────────────────────────────

async function upsertBankAccount(
  url: string, key: string,
  companyId: string, bankCode: string, bankName: string,
  accountNumber: string, ifsc: string | null,
): Promise<{ id: string; ledger_id: string | null }> {
  // Try to find existing
  const existing = (await dbGet(url, key,
    `recon_bank_accounts?company_id=eq.${companyId}&bank_code=eq.${encodeURIComponent(bankCode)}&account_number=eq.${encodeURIComponent(accountNumber)}&select=id,ledger_id`)) as { id: string; ledger_id: string | null }[]

  if (existing.length) return existing[0]

  const [created] = await dbPost(url, key, 'recon_bank_accounts', {
    company_id:     companyId,
    bank_code:      bankCode,
    bank_name:      bankName,
    account_number: accountNumber,
    ifsc:           ifsc ?? null,
    currency:       'INR',
    is_active:      true,
  })
  return { id: created.id, ledger_id: null }
}

async function getBankAccount(
  url: string, key: string,
  companyId: string, bankCode: string, accountNumber: string,
): Promise<{ id: string; ledger_id: string | null } | null> {
  const rows = (await dbGet(url, key,
    `recon_bank_accounts?company_id=eq.${companyId}&bank_code=eq.${encodeURIComponent(bankCode)}&account_number=eq.${encodeURIComponent(accountNumber)}&select=id,ledger_id`)) as { id: string; ledger_id: string | null }[]
  return rows[0] ?? null
}

// ── Format profile upsert ─────────────────────────────────────────────────────

async function upsertFormatProfile(
  url: string, key: string,
  bankCode: string, signature: string,
  mapping: unknown, headerRow: string[],
  method: 'heuristic' | 'ai',
): Promise<string | null> {
  try {
    const existing = (await dbGet(url, key,
      `recon_format_profiles?bank_code=eq.${encodeURIComponent(bankCode)}&format_signature=eq.${encodeURIComponent(signature)}&select=id`)) as { id: string }[]

    if (existing.length) {
      // Only update last_used_at — times_used is NOT NULL and PostgREST can't do += 1 in PATCH
      await dbPatch(url, key,
        `recon_format_profiles?bank_code=eq.${encodeURIComponent(bankCode)}&format_signature=eq.${encodeURIComponent(signature)}`,
        { last_used_at: new Date().toISOString() })
      return existing[0].id
    }

    const [created] = await dbPost(url, key, 'recon_format_profiles', {
      bank_code:        bankCode,
      format_signature: signature,
      column_mapping:   mapping,
      sample_headers:   headerRow.filter(h => h.trim().length > 0),
      detection_method: method,
    })
    return created.id
  } catch {
    return null
  }
}

// ── Overlap check ─────────────────────────────────────────────────────────────

async function checkOverlap(
  url: string, key: string,
  companyId: string, bankCode: string, accountNumber: string,
  periodFrom: string, periodTo: string,
): Promise<UploadResponse['overlap'] | null> {
  const account = await getBankAccount(url, key, companyId, bankCode, accountNumber)
  if (!account) return null

  const overlapping = (await dbGet(url, key,
    `recon_statements?bank_account_id=eq.${account.id}` +
    `&period_from=lte.${periodTo}&period_to=gte.${periodFrom}&select=id,period_from,period_to`)) as { id: string; period_from: string; period_to: string }[]

  if (!overlapping.length) return null

  const existing = overlapping[0]
  // Overlap range
  const overlapFrom = periodFrom > existing.period_from ? periodFrom : existing.period_from
  const overlapTo   = periodTo   < existing.period_to   ? periodTo   : existing.period_to

  return {
    existing_statement_id: existing.id,
    existing_period_from:  existing.period_from,
    existing_period_to:    existing.period_to,
    overlap_from:          overlapFrom,
    overlap_to:            overlapTo,
    duplicate_txn_count:   0,  // would require counting — advisory only
  }
}

// ── Supabase Storage helpers ──────────────────────────────────────────────────

async function storeRawFile(
  url: string, key: string,
  companyId: string, rawBytes: Buffer, fileName: string,
): Promise<string> {
  const path = `${companyId}/${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`
  const res = await fetch(`${url}/storage/v1/object/bank-recon-raw/${path}`, {
    method: 'POST',
    headers: {
      apikey:         key,
      Authorization:  `Bearer ${key}`,
      'Content-Type': 'application/octet-stream',
    },
    body: new Uint8Array(rawBytes),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Storage upload failed ${res.status}: ${err}`)
  }
  return path
}

async function downloadRawFile(url: string, key: string, path: string): Promise<Buffer | null> {
  const res = await fetch(`${url}/storage/v1/object/bank-recon-raw/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })
  if (!res.ok) return null
  return Buffer.from(await res.arrayBuffer())
}

// ── Format profiles loader ────────────────────────────────────────────────────

async function loadFormatProfiles(
  url: string, key: string, bankCode?: string,
): Promise<Map<string, { id: string; column_mapping: ColumnMapping }>> {
  const path = bankCode
    ? `recon_format_profiles?bank_code=eq.${encodeURIComponent(bankCode)}&select=id,bank_code,format_signature,column_mapping`
    : `recon_format_profiles?select=id,bank_code,format_signature,column_mapping&limit=500`
  const rows = (await dbGet(url, key, path)) as { id: string; bank_code: string; format_signature: string; column_mapping: ColumnMapping }[]

  const map = new Map<string, { id: string; column_mapping: ColumnMapping }>()
  for (const r of rows) {
    map.set(`${r.bank_code}:${r.format_signature}`, { id: r.id, column_mapping: r.column_mapping })
  }
  return map
}

// ── Summary builder ───────────────────────────────────────────────────────────

function buildSummary(
  preResult: Awaited<ReturnType<typeof runPreConverter>>,
): UploadResponse['summary'] {
  return {
    bank:            { code: preResult.bank.bank_code, name: preResult.bank.bank_name, confidence: preResult.bank.confidence },
    account_number:  preResult.bank.account_number,
    period_from:     preResult.period_from,
    period_to:       preResult.period_to,
    txn_count:       preResult.transactions.length,
    debit_count:     preResult.transactions.filter(t => t.debit !== null).length,
    credit_count:    preResult.transactions.filter(t => t.credit !== null).length,
    total_debits:    preResult.validation.total_debits,
    total_credits:   preResult.validation.total_credits,
    opening_balance: preResult.opening_balance,
    closing_balance: preResult.closing_balance,
  }
}
