-- ============================================================
-- Sofitect MCP — Checkout Report table
-- Paste into Supabase SQL Editor and run
-- ============================================================

create table if not exists checkout_reports (
  id            uuid primary key default gen_random_uuid(),
  client_id     text not null,
  property_ref  text not null,          -- e.g. "PROP-2024-0042"
  property_addr text not null,          -- full address
  tenant_name   text not null,
  checkout_date date not null,
  generated_at  timestamptz default now(),

  -- Condition sections stored as JSONB arrays of {room, item, condition, notes}
  rooms         jsonb not null default '[]',

  -- Summary fields
  overall_condition  text,              -- excellent | good | fair | poor
  deposit_deductions jsonb default '[]',-- [{item, cost, reason}]
  total_deductions   numeric(10,2) default 0,
  report_text        text,              -- the full generated narrative
  status             text default 'draft' -- draft | finalised
);

create index if not exists checkout_reports_client_idx
  on checkout_reports (client_id, checkout_date desc);
