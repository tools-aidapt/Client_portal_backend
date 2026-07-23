-- ============================================================================
-- 0011  Global seed defaults
-- ----------------------------------------------------------------------------
-- Global ClickUp status -> client bucket map (tenant_id = null). New tenants
-- inherit these during onboarding (step `link_clickup`) and may override
-- per-tenant rows later.
-- ============================================================================

insert into portal.clickup_status_map (tenant_id, raw_status, bucket, sort_order) values
  (null, 'to do',        'upcoming',    10),
  (null, 'open',         'upcoming',    11),
  (null, 'planned',      'upcoming',    12),
  (null, 'backlog',      'upcoming',    13),
  (null, 'in progress',  'in_progress', 20),
  (null, 'in review',    'in_progress', 21),
  (null, 'review',       'in_progress', 22),
  (null, 'blocked',      'in_progress', 23),
  (null, 'complete',     'delivered',   30),
  (null, 'done',         'delivered',   31),
  (null, 'closed',       'delivered',   32)
on conflict (tenant_id, raw_status) do nothing;
