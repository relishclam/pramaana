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

    type ReqBody = { email?: string; redirectTo?: string; userId?: string; password?: string; fullName?: string }
    const body = await req.json().catch(() => ({})) as ReqBody

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    // ── 2a. Set-password path: { userId, password } ────────────────────────────
    // Used by the Edit User panel to set/reset a user's password server-side.
    if (body.userId && body.password) {
      if (body.password.length < 8) {
        return json({ error: 'Password must be at least 8 characters' }, 400)
      }
      const { error: pwErr } = await admin.auth.admin.updateUserById(
        body.userId,
        { password: body.password },
      )
      if (pwErr) {
        return json({ error: pwErr.message }, 400)
      }
      return json({ success: true, userId: body.userId })
    }

    // ── 2b. Invite path: { email, redirectTo? } ────────────────────────────────
    const email = (body.email ?? '').trim().toLowerCase()
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: 'Invalid email address' }, 400)
    }
    const redirectTo: string | undefined = body.redirectTo ?? undefined

    const { data, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(
      email,
      redirectTo ? { redirectTo } : undefined,
    )
    if (inviteErr) {
      return json({ error: inviteErr.message }, 400)
    }

    const userId = data.user?.id
    if (userId) {
      // Bootstrap a profile row — non-fatal if it already exists.
      try {
        const { error: profileErr } = await admin
          .schema('registry')
          .from('profiles')
          .upsert(
            { id: userId, email, is_active: true, is_super_admin: false },
            { onConflict: 'id', ignoreDuplicates: true },
          )
        if (profileErr) {
          console.error('invite-user: profile upsert failed (non-fatal):', profileErr.message)
        }
      } catch (profileEx) {
        console.error('invite-user: profile upsert threw (non-fatal):', profileEx)
      }
    }

    return json({ success: true, userId: userId ?? null })

  } catch (err: unknown) {
    return json({ error: err instanceof Error ? err.message : 'Unexpected error' }, 500)
  }
})
