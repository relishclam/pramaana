import os
import uuid
from supabase import create_client

sb = create_client(
    os.environ["SUPABASE_URL"],
    os.environ["SUPABASE_SERVICE_ROLE_KEY"]
)

COMPANY_ID      = "bc455c94-0bcd-4d66-a040-d29ed880d22f"
ENTITY_ID       = "190921c6-9b3c-42ed-abc6-f8ae316c11c3"
PENINSULAR      = "74ecf056-0658-4193-8ec5-6b4802e016e0"
RENT_RECEIVED   = "413da013-8dd9-4540-8b4c-472c1f0f2348"
TDS_RECEIVABLE  = "af6e8191-0191-48ac-be63-2f3f93aa6072"
JOURNAL_TYPE_ID = "45f2422c-410d-4662-9bf3-d391a2a83b35"

# Source: 26AS AAACR7749E FY2025-26 — DO NOT MODIFY
ENTRIES = [
    ("2025-04-30", 192938.00, 19293.80),
    ("2025-05-31", 192930.00, 19293.00),
    ("2025-06-30", 192938.00, 19293.80),
    ("2025-07-31", 210000.00, 21000.00),
    ("2025-08-31", 210000.00, 21000.00),
    ("2025-09-30", 210000.00, 21000.00),
    ("2025-10-31", 210000.00, 21000.00),
    ("2025-11-30", 210000.00, 21000.00),
    ("2025-12-31", 210000.00, 21000.00),
    ("2026-01-31", 210000.00, 21000.00),
    ("2026-02-28", 210000.00, 21000.00),
    ("2026-03-31", 210000.00, 21000.00),
]

total_gross = total_tds = total_net = 0

for i, (dt, gross, tds) in enumerate(ENTRIES, 1):
    net = round(gross - tds, 2)
    total_gross += gross
    total_tds   += tds
    total_net   += net
    voucher_id  = str(uuid.uuid4())
    num         = f"JNL/2526/{i:04d}"

    # Insert as draft first — trigger blocks entries on posted vouchers
    sb.schema("pramaana").table("vouchers").insert({
        "id":             voucher_id,
        "company_id":     COMPANY_ID,
        "entity_id":      ENTITY_ID,
        "voucher_number": num,
        "voucher_date":   dt,
        "amount":         gross,
        "status":         "draft",
        "source":         "manual",
        "narration":      f"Rent accrual — Peninsular Fisheries {dt[:7]} [26AS AAACR7749E verified]",
        "voucher_type_id": JOURNAL_TYPE_ID,
    }).execute()

    sb.schema("pramaana").table("voucher_entries").insert([
        {"voucher_id": voucher_id, "ledger_id": PENINSULAR,
         "entry_type": "Dr", "amount": gross},
        {"voucher_id": voucher_id, "ledger_id": RENT_RECEIVED,
         "entry_type": "Cr", "amount": net},
        {"voucher_id": voucher_id, "ledger_id": TDS_RECEIVABLE,
         "entry_type": "Cr", "amount": tds},
    ]).execute()

    sb.schema("pramaana").table("vouchers") \
        .update({"status": "posted"}) \
        .eq("id", voucher_id) \
        .execute()

    print(f"✓ {num}  {dt}  Gross={gross:,.2f}  TDS={tds:,.2f}  Net={net:,.2f}")

print(f"\nTotals — Gross: {total_gross:,.2f}  TDS: {total_tds:,.2f}  Net: {total_net:,.2f}")
print("Expected — Gross: 2,468,806.00  TDS: 246,880.60  Net: 2,221,925.40")
