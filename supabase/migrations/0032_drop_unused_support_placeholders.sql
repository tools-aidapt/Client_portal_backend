-- 0032  drop the two genuinely-dead support.* placeholder tables
-- ----------------------------------------------------------------------------
-- support.tickets / ticket_messages (0007_support_tables.sql) were built with
-- FKs into core.profiles/core.tenants but never wired to any live app —
-- confirmed 0 rows and 0 code references anywhere before dropping.
--
-- support.categories and support.tenant_support_summary are NOT touched here —
-- despite looking like the same kind of placeholder, they're actually live:
-- onboarding.repository.ts's insertSupportDefaults() writes both on every new
-- client, and portal.repository.ts's supportSummary() reads
-- tenant_support_summary for the Dashboard's Support tile. Real, if perpetually
-- stale (that table is never updated after the initial insert) — a separate,
-- unrelated finding, not this migration's concern.
-- ============================================================================

drop table if exists support.ticket_messages cascade;
drop table if exists support.tickets cascade;
