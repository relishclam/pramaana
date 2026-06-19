import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_CLAMFLOW_SUPABASE_URL as string
const key = import.meta.env.VITE_CLAMFLOW_SUPABASE_ANON_KEY as string

if (!url || !key) {
  throw new Error('Missing VITE_CLAMFLOW_SUPABASE_URL or VITE_CLAMFLOW_SUPABASE_ANON_KEY in .env')
}

// READ ONLY — NEVER call INSERT, UPDATE, or DELETE on this client.
// ClamFlow data is owned by the ClamFlow application.
export const supabaseClamFlow = createClient(url, key)
