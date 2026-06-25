-- ── Invoice Scan Module ───────────────────────────────────────────────────────
-- Migration: 20260625000000_invoice_scan_module.sql
-- Adds: invoice_scans, invoice_scan_items tables
-- Target: Supabase project mmkbknnzgpvsqgnynrbe
-- Safe: all statements are idempotent (IF NOT EXISTS)
-- ─────────────────────────────────────────────────────────────────────────────
-- NOTE: registry.companies already has a `code` column — no ALTER needed.
-- NOTE: company_id is stored as plain UUID (no FK to registry.companies)
--       matching the pattern used by pramaana.inventory_valuations and
--       pramaana.voucher_attachments.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── invoice_scans ─────────────────────────────────────────────────────────────
create table if not exists pramaana.invoice_scans (
  id              uuid        primary key default gen_random_uuid(),
  company_id      uuid        not null,   -- registry.companies(id), no FK (cross-schema)
  scan_ref        text        unique not null,
  -- Naming: {CompanyCode}/{FY}/{Type}/{YYYYMMDD}-{InvoiceNo}-{Party}
  -- Example: RHHF/2526/PUR/20250615-INV0234-RelishFoods

  type            text        not null check (type in ('purchase', 'sale')),

  -- Extracted header fields
  invoice_no      text,
  invoice_date    date,
  party_name      text,
  party_gstin     text,
  our_gstin       text,
  taxable_value   numeric(14,2) default 0,
  total_gst       numeric(14,2) default 0,
  cgst            numeric(14,2) default 0,
  sgst            numeric(14,2) default 0,
  igst            numeric(14,2) default 0,
  total_amount    numeric(14,2) default 0,
  gst_type        text check (gst_type in ('intra','inter','unknown')),

  -- Raw extraction (always kept as fallback)
  raw_json        jsonb,
  confidence      numeric(5,2),

  -- File linkage (existing bill-attachments bucket)
  storage_path    text,

  -- Workflow status
  status          text        not null default 'pending'
                  check (status in ('pending','reviewed','voucher_created','rejected')),
  voucher_id      uuid,   -- populated when voucher is created from this scan

  -- Audit
  scanned_by      uuid        references auth.users(id),
  scanned_at      timestamptz not null default now(),
  reviewed_by     uuid        references auth.users(id),
  reviewed_at     timestamptz
);

-- ── invoice_scan_items ────────────────────────────────────────────────────────
create table if not exists pramaana.invoice_scan_items (
  id              uuid        primary key default gen_random_uuid(),
  scan_id         uuid        not null references pramaana.invoice_scans(id) on delete cascade,
  company_id      uuid        not null,   -- registry.companies(id), no FK (cross-schema)
  line_no         integer     not null,   -- preserves original invoice line order

  -- Extracted fields
  description     text,
  hsn_sac         text,
  quantity        numeric(14,3),
  unit            text,              -- KG, NOS, MTR, LTR etc
  unit_price      numeric(14,2),
  amount          numeric(14,2),

  -- Classification (filled during review step, not from OCR)
  item_category   text check (item_category in (
                    'raw_material','spare','consumable',
                    'maintenance','packaging','other'
                  )),
  item_code       text,              -- future inventory master linkage

  -- Three-way matching hooks (future PO module)
  po_item_id      uuid,
  grn_item_id     uuid,
  matched_status  text        not null default 'unmatched'
                  check (matched_status in ('unmatched','partial','matched')),

  created_at      timestamptz not null default now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
create index if not exists invoice_scans_company_status
  on pramaana.invoice_scans (company_id, status);

create index if not exists invoice_scans_company_type_date
  on pramaana.invoice_scans (company_id, type, invoice_date desc);

create index if not exists invoice_scan_items_scan_id
  on pramaana.invoice_scan_items (scan_id);

create index if not exists invoice_scan_items_company_category
  on pramaana.invoice_scan_items (company_id, item_category);

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table pramaana.invoice_scans      enable row level security;
alter table pramaana.invoice_scan_items enable row level security;

-- ── invoice_scans policies ────────────────────────────────────────────────────

create policy "company members can view invoice scans"
  on pramaana.invoice_scans for select
  to authenticated
  using (
    company_id in (
      select company_id from registry.company_users
      where user_id = auth.uid()
    )
  );

create policy "accounts and admin can insert invoice scans"
  on pramaana.invoice_scans for insert
  to authenticated
  with check (
    company_id in (
      select company_id from registry.company_users
      where user_id = auth.uid()
        and role in ('admin', 'accounts', 'super_admin')
    )
  );

create policy "accounts and admin can update invoice scans"
  on pramaana.invoice_scans for update
  to authenticated
  using (
    company_id in (
      select company_id from registry.company_users
      where user_id = auth.uid()
        and role in ('admin', 'accounts', 'super_admin')
    )
  );

-- ── invoice_scan_items policies ───────────────────────────────────────────────

create policy "company members can view invoice scan items"
  on pramaana.invoice_scan_items for select
  to authenticated
  using (
    company_id in (
      select company_id from registry.company_users
      where user_id = auth.uid()
    )
  );

create policy "accounts and admin can insert invoice scan items"
  on pramaana.invoice_scan_items for insert
  to authenticated
  with check (
    company_id in (
      select company_id from registry.company_users
      where user_id = auth.uid()
        and role in ('admin', 'accounts', 'super_admin')
    )
  );

create policy "accounts and admin can update invoice scan items"
  on pramaana.invoice_scan_items for update
  to authenticated
  using (
    company_id in (
      select company_id from registry.company_users
      where user_id = auth.uid()
        and role in ('admin', 'accounts', 'super_admin')
    )
  );

-- ── Grants ────────────────────────────────────────────────────────────────────
grant select, insert, update
  on pramaana.invoice_scans, pramaana.invoice_scan_items
  to authenticated;

grant all
  on pramaana.invoice_scans, pramaana.invoice_scan_items
  to service_role;

