/**
 * invite-user — Supabase Edge Function (Deno)
 *
 * Sends a Supabase magic-link invite to a new user email.
 * Must run server-side because auth.admin.inviteUserByEmail()
 * requires the service_role key — it cannot be called from the browser.
 *
 * Called by both Relish Suite and Pramaana via:
 *   supabase.functions.invoke('invite-user', { body: { email, redirectTo? } })
 *
 * Security:
 *   - Caller must be authenticated (valid JWT forwarded in Authorization header)
 *   - Caller must have is_super_admin = TRUE in registry.profiles
 *   - Email is validated server-side before calling the Auth API
 *
 * Dashboard setting: "Verify JWT with legacy secret" → OFF
 *   (We do our own JWT verification via /auth/v1/user)
 *
 * Supabase built-ins (auto-injected, never exposed to browser):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { serve }        from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── CORS ──────────────────────────────────────────────────────────────────────

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

// ── Handler ───────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')              ?? ''
  const SERVICE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ error: 'Server misconfiguration: missing Supabase env vars' }, 500)
  }

  try {
    // ── 1. Extract caller JWT ─────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? ''
    if (!authHeader.startsWith('Bearer ')) {
      return json({ error: 'Unauthorized' }, 401)
    }
    const callerJwt = authHeader.slice(7)

    // ── 2. Verify JWT via Auth API (raw fetch — most reliable in Deno) ────────
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey':        SERVICE_KEY,
        'Authorization': `Bearer ${callerJwt}`,
      },
    })
    if (!userRes.ok) {
      return json({ error: 'Invalid or expired token' }, 401)
    }
    const userData = await userRes.json() as { id?: string }
    const callerId = userData.id
    if (!callerId) {
      return json({ error: 'Invalid or expired token' }, 401)
    }

    // ── 3. Check is_super_admin via PostgREST (raw fetch — avoids Deno client issues) ──
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?select=is_super_admin&id=eq.${callerId}&limit=1`,
      {
        headers: {
          'apikey':         SERVICE_KEY,
          'Authorization':  `Bearer ${SERVICE_KEY}`,
          'Accept-Profile': 'registry',
        },
      },
    )
    const profiles = profileRes.ok ? await profileRes.json() as { is_super_admin: boolean }[] : []
    if (!profiles[0]?.is_super_admin) {
      return json({ error: 'Forbidden: super_admin access required to invite users' }, 403)
    }

    // ── 4. Validate email ─────────────────────────────────────────────────────
    const body = await req.json().catch(() => ({})) as { email?: string; redirectTo?: string }
    const email = (body.email ?? '').trim().toLowerCase()
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: 'Invalid email address' }, 400)
    }
    const redirectTo: string | undefined = body.redirectTo ?? undefined

    // ── 5. Send invite via admin client ───────────────────────────────────────
    const adminClient = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data, error: inviteErr } = await adminClient.auth.admin.inviteUserByEmail(
      email,
      redirectTo ? { redirectTo } : undefined,
    )
    if (inviteErr) {
      return json({ error: inviteErr.message }, 400)
    }

    return json({ success: true, userId: data.user?.id ?? null })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unexpected error'
    return json({ error: msg }, 500)
  }
})
