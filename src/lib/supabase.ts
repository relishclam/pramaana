import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// pramaana-schema-scoped client — used by the Settlement module and any other
// code that must hit pramaana tables/RPCs directly from the browser.
// separate storageKey avoids the "multiple GoTrueClient instances" warning
export const supabasePramaana = createClient(supabaseUrl, supabaseAnonKey, {
  db: { schema: 'pramaana' },
  auth: { storageKey: 'sb-pramaana-schema' },
})
