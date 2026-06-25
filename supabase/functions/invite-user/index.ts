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

// ── Handler ───────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')              ?? ''
    const SERVICE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    if (!SUPABASE_URL || !SERVICE_KEY) {
      throw new Error('Server misconfiguration: missing Supabase env vars')
    }

    // ── 1. Verify the caller is an authenticated super-admin ──────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const callerJwt   = authHeader.slice(7)
    const callerClient = createClient(SUPABASE_URL, SERVICE_KEY)

    // Verify JWT and get caller's user id
    const { data: { user: caller }, error: jwtErr } = await callerClient.auth.getUser(callerJwt)
    if (jwtErr || !caller) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // Check is_super_admin in registry.profiles
    const { data: profile } = await callerClient
      .schema('registry')
      .from('profiles')
      .select('is_super_admin')
      .eq('id', caller.id)
      .single()

    if (!profile?.is_super_admin) {
      return new Response(
        JSON.stringify({ error: 'Forbidden: super_admin access required to invite users' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // ── 2. Parse and validate request body ────────────────────────────────────
    const body = await req.json().catch(() => ({}))
    const email: string = (body.email ?? '').trim().toLowerCase()

    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!email || !EMAIL_RE.test(email)) {
      return new Response(
        JSON.stringify({ error: 'Invalid email address' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // Optional redirect URL — defaults to Suite if not provided
    const redirectTo: string | undefined = body.redirectTo ?? undefined

    // ── 3. Send the invite using the service_role admin client ────────────────
    const adminClient = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data, error: inviteErr } = await adminClient.auth.admin.inviteUserByEmail(
      email,
      redirectTo ? { redirectTo } : undefined,
    )

    if (inviteErr) {
      // Surface Supabase's own error message (e.g. "User already registered")
      return new Response(
        JSON.stringify({ error: inviteErr.message }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    return new Response(
      JSON.stringify({ success: true, userId: data.user?.id ?? null }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unexpected error'
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
