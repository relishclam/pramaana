#!/usr/bin/env python3
"""
verify_constraints.py — Read live DB constraint definitions after migrations.
Requires DATABASE_URL in .env (direct connection, not pooler).
"""

import os, sys
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# Use DB_PASSWORD (plain text, no URL-encoding needed) rather than DATABASE_URL
# to avoid URL-parsing failures when the password contains $, @, :, etc.
DB_PASSWORD = os.environ.get("DB_PASSWORD") or os.environ.get("DATABASE_URL")
if not DB_PASSWORD:
    print("ERROR: DB_PASSWORD not in .env")
    print("  Add a line:  DB_PASSWORD=yourpassword")
    sys.exit(1)

import psycopg2
# If it looks like a full URL fall back to URL connect, otherwise use keyword args
if DB_PASSWORD.startswith("postgresql"):
    conn = psycopg2.connect(DB_PASSWORD)
else:
    conn = psycopg2.connect(
        host="db.mmkbknnzgpvsqgnynrbe.supabase.co",
        port=5432,
        dbname="postgres",
        user="postgres",
        password=DB_PASSWORD,
    )
cur = conn.cursor()

# Migration order verification
print("Migration file order (077 must precede 078):")
migs = sorted(Path("supabase/migrations").glob("0[78][78]*.sql"))
for m in migs:
    print(f"  {m.name}")

print()

# Live match_method CHECK constraint
cur.execute("""
    SELECT conname, pg_get_constraintdef(oid)
    FROM pg_constraint
    WHERE conrelid = 'pramaana.recon_matches'::regclass
      AND conname  = 'recon_matches_match_method_check'
""")
row = cur.fetchone()
if row:
    print(f"Live constraint name: {row[0]}")
    print(f"Live constraint def:  {row[1]}")
else:
    print("ERROR: constraint not found on live DB")

# Live trigger body (confirm utr carve-out in 077)
print()
cur.execute("""
    SELECT prosrc
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'pramaana'
      AND p.proname = 'prevent_posted_voucher_update'
""")
row = cur.fetchone()
if row:
    src = row[0]
    has_utr_carve = "utr_number" in src and "RETURN NEW" in src
    print(f"Trigger fn has utr_number carve-out: {has_utr_carve}")
    if not has_utr_carve:
        print("WARNING: migration 077 may not have applied correctly")
else:
    print("ERROR: trigger function not found")

conn.close()
