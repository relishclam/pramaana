#!/usr/bin/env python3
"""
apply_migrations.py — Apply pending Pramaana migrations via direct Postgres connection.

USAGE:
  Set DATABASE_URL in .env or export it, then:
    python scripts/apply_migrations.py [--migrations 077 078]

  The DATABASE_URL must be a direct connection (not pooler) with DDL privileges:
    postgresql://postgres:PASSWORD@db.mmkbknnzgpvsqgnynrbe.supabase.co:5432/postgres

  To get the DB password:
    Supabase Dashboard → Project Settings → Database → Connection info → Password
    (or use "Reset database password" if unknown)

  Set DATABASE_URL in .env:
    DATABASE_URL=postgresql://postgres:PASSWORD@db.mmkbknnzgpvsqgnynrbe.supabase.co:5432/postgres

INSTALLS:
    pip install psycopg2-binary
"""

import os, sys
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

MIGRATIONS_DIR = Path(__file__).parent.parent / "supabase" / "migrations"

# Filter to specific migrations if --migrations flag given
apply_only: list[str] = []
if "--migrations" in sys.argv:
    idx = sys.argv.index("--migrations")
    apply_only = sys.argv[idx + 1].split(",") if idx + 1 < len(sys.argv) else []

# Use DB_PASSWORD (plain text) to avoid URL-parsing failures with special chars.
DB_PASSWORD = os.environ.get("DB_PASSWORD") or os.environ.get("DATABASE_URL")
if not DB_PASSWORD:
    print("ERROR: DB_PASSWORD not in .env")
    print("  Add a line:  DB_PASSWORD=yourpassword")
    sys.exit(1)

try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2 not installed. Run:  pip install psycopg2-binary")
    sys.exit(1)

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
conn.autocommit = False

migration_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
if apply_only:
    migration_files = [f for f in migration_files if any(f.name.startswith(n) for n in apply_only)]

print(f"Applying {len(migration_files)} migration(s) from {MIGRATIONS_DIR}")
print()

for mf in migration_files:
    sql = mf.read_text(encoding="utf-8")
    print(f"── {mf.name} ──")
    try:
        with conn.cursor() as cur:
            cur.execute(sql)
        conn.commit()
        print(f"   OK")
    except Exception as e:
        conn.rollback()
        print(f"   FAILED: {e}")
        print("   Transaction rolled back.")
        sys.exit(1)

conn.close()
print()
print("All done.")
