-- ════════════════════════════════════════════════════════════════════════════
-- 046_orphan_sweep.sql — Orphan audit across auth.users ↔ registry.profiles
-- READ-ONLY: run in Supabase SQL Editor as service_role whenever needed.
-- Surfaces users whose invite went through but profile creation failed,
-- users who exist in profiles but were deleted from auth, etc.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. auth.users with NO profiles row (half-created invites) ────────────────
SELECT
    'auth_no_profile'          AS issue,
    au.id,
    au.email,
    au.invited_at,
    au.confirmed_at,
    au.last_sign_in_at,
    au.created_at
FROM  auth.users au
LEFT  JOIN registry.profiles p ON p.id = au.id
WHERE p.id IS NULL
  AND au.deleted_at IS NULL
ORDER BY au.created_at;

-- ── 2. profiles with NO auth.users row (dangling registry rows) ──────────────
SELECT
    'profile_no_auth'          AS issue,
    p.id,
    p.email,
    p.full_name,
    p.is_active,
    p.created_at
FROM  registry.profiles p
LEFT  JOIN auth.users au ON au.id = p.id
WHERE au.id IS NULL
ORDER BY p.created_at;

-- ── 3. profiles with NO company_users assignment (invited but not onboarded) ─
SELECT
    'profile_no_company'       AS issue,
    p.id,
    p.email,
    p.full_name,
    p.is_active,
    p.created_at
FROM  registry.profiles p
LEFT  JOIN registry.company_users cu ON cu.user_id = p.id
WHERE cu.user_id IS NULL
  AND p.is_active = true
ORDER BY p.created_at;

-- ── 4. Summary counts ────────────────────────────────────────────────────────
SELECT
    (SELECT count(*) FROM auth.users au
     LEFT JOIN registry.profiles p ON p.id = au.id
     WHERE p.id IS NULL AND au.deleted_at IS NULL)          AS auth_no_profile,

    (SELECT count(*) FROM registry.profiles p
     LEFT JOIN auth.users au ON au.id = p.id
     WHERE au.id IS NULL)                                   AS profile_no_auth,

    (SELECT count(*) FROM registry.profiles p
     LEFT JOIN registry.company_users cu ON cu.user_id = p.id
     WHERE cu.user_id IS NULL AND p.is_active = true)       AS profile_no_company,

    (SELECT count(*) FROM auth.users WHERE deleted_at IS NULL) AS total_auth_users,
    (SELECT count(*) FROM registry.profiles)               AS total_profiles,
    (SELECT count(*) FROM registry.company_users)          AS total_company_assignments;
