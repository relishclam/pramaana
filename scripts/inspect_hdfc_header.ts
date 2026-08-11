#!/usr/bin/env tsx
// Verify bank-detect fix: account_number must be detected for both HDFC files
import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
const __dir = dirname(fileURLToPath(import.meta.url))
const envPath = resolve(__dir, '..', '.env')
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf8').split('\n')
  for (const line of lines) {
    const idx = line.indexOf('=')
    if (idx < 1 || line.trimStart().startsWith('#')) continue
    const k = line.slice(0, idx).trim()
    let v = line.slice(idx + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (k && !(k in process.env)) process.env[k] = v
  }
}

import { runPreConverter } from '../api/lib/bank-recon/pre-converter.js'

const FILES: Array<[string, string]> = [
  ['No-Lien 1702', 'C:\\Users\\user\\Downloads\\Acct_Statement_XXXXXXXX1702_11082026.xls'],
  ['Current 2324',  'C:\\Users\\user\\Downloads\\Acct_Statement_XXXXXXXX2324_11082026.xls'],
]

for (const [label, file] of FILES) {
  const raw = new Uint8Array(readFileSync(file))
  const fname = file.split('\\').pop() ?? file
  const r = await runPreConverter(raw, fname)
  const pass = r.bank.account_number !== null
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: account_number=${r.bank.account_number}  ifsc=${r.bank.ifsc}  conf=${r.bank.confidence}%`)
  if (!pass) console.log('  STILL NULL — fix did not work')
}

