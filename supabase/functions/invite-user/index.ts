/**
 * invite-user — Supabase Edge Function (Deno)
 *
 * Sends a Supabase magic-link invite to a new user email.
 * Must run server-side because auth.admin.inviteUserByEmail()
 * requires the service_role key — it cannot be called from the browser.
 *
 * Called by Relish Suite via:
 *   supabase.functions.invoke('invite-user', { body: { email, redirectTo? } })
 *
 * Security:
 *   - Caller must have a valid, non-expired Supabase session JWT
 *   - Page-level access (super_admin only) is enforced by the Suite ProtectedRoute
 *   - Email is validated server-side before the Auth API call
 *
 * Dashboard: "Verify JWT with legacy secret" → OFF
 *
 * Supabase built-ins (auto-injected, never exposed to browser):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { serve }        from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')              ?? ''
  const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ error: 'Server misconfiguration' }, 500)
  }

  try {
    // ── 1. Require an authenticated caller (valid session JWT) ─────────────────
    const authHeader = req.headers.get('Authorization') ?? ''
    if (!authHeader.startsWith('Bearer ')) {
      return json({ error: 'Unauthorized' }, 401)
    }
    const callerJwt = authHeader.slice(7)

    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey':        SERVICE_KEY,
        'Authorization': `Bearer ${callerJwt}`,
      },
    })
    if (!userRes.ok) {
      return json({ error: 'Invalid or expired session' }, 401)
    }

    // ── 2. Validate email ──────────────────────────────────────────────────────
    const body = await req.json().catch(() => ({})) as { email?: string; redirectTo?: string }
    const email = (body.email ?? '').trim().toLowerCase()
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: 'Invalid email address' }, 400)
    }
    const redirectTo: string | undefined = body.redirectTo ?? undefined

    // ── 3. Send the magic-link invite ──────────────────────────────────────────
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(
      email,
      redirectTo ? { redirectTo } : undefined,
    )
    if (inviteErr) {
      return json({ error: inviteErr.message }, 400)
    }

    return json({ success: true, userId: data.user?.id ?? null })

  } catch (err: unknown) {
    return json({ error: err instanceof Error ? err.message : 'Unexpected error' }, 500)
  }
})
