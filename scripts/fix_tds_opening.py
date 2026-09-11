import os
from supabase import create_client

sb = create_client(
    os.environ["SUPABASE_URL"],
    os.environ["SUPABASE_SERVICE_ROLE_KEY"]
)

COMPANY_ID = "bc455c94-0bcd-4d66-a040-d29ed880d22f"
LEDGER_ID  = "dac7e2eb-c7ed-4a29-a367-21a4d382a9c6"  # TDS Receivable — 194I (Rent)

# Restore audited opening balance on TDS Receivable — 194I (Rent)
result = sb.schema("pramaana").table("ledgers").update({
    "opening_balance": 228771.00,
    "opening_dr_cr": "Dr"
}).eq("id", LEDGER_ID).eq("company_id", COMPANY_ID).execute()

print("Updated rows:", len(result.data))

# Verify
check = sb.schema("pramaana").table("ledgers").select(
    "name, opening_balance, opening_dr_cr"
).eq("id", LEDGER_ID).execute()

print("Verified:", check.data)

# Opening balance totals
all_ledgers = sb.schema("pramaana").table("ledgers").select(
    "opening_balance, opening_dr_cr"
).eq("company_id", COMPANY_ID).eq("is_active", True).execute()

dr = sum(r["opening_balance"] for r in all_ledgers.data if r["opening_dr_cr"] == "Dr")
cr = sum(r["opening_balance"] for r in all_ledgers.data if r["opening_dr_cr"] == "Cr")

print(f"\nOpening Balance Summary:")
print(f"  Dr: {dr:,.2f}")
print(f"  Cr: {cr:,.2f}")
print(f"  Gap: {abs(dr - cr):,.2f} ({'Dr excess' if dr > cr else 'Cr excess'})")
