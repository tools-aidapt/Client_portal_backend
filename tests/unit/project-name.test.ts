import { describe, expect, it } from 'vitest';
import { parseProjectName } from '@modules/portal/project-name.js';

describe('parseProjectName', () => {
  it.each([
    ['Ops - Invoice Automation', 'operations', 'Invoice Automation'],
    ['operations: Claims Triage', 'operations', 'Claims Triage'],
    ['OPS | Onboarding', 'operations', 'Onboarding'],
    ['Intel – Sales Dashboard', 'intelligence', 'Sales Dashboard'],
    ['Intelligence — Churn Model', 'intelligence', 'Churn Model'],
    ['INT - SSA Analytics', 'intelligence', 'SSA Analytics'],
    ['INTL - Snowflake Project', 'intelligence', 'Snowflake Project'],
    ['Enablement - Academy Rollout', 'enablement', 'Academy Rollout'],
    ['Enable Team Training', 'enablement', 'Team Training'],
    ['ops-Tight', 'operations', 'Tight'],
    ['OPS/INT - Dashboarding for CRM', 'operations_intelligence', 'Dashboarding for CRM'],
    ['OPS / INTL - X', 'operations_intelligence', 'X'],
    ['INT & OPS: X', 'operations_intelligence', 'X'],
    ['Ops+Intel X', 'operations_intelligence', 'X'],
    ['Operations, Intelligence | X', 'operations_intelligence', 'X'],
    ['intelligence and operations - X', 'operations_intelligence', 'X'],
  ])('%s', (input, capability, display) => {
    expect(parseProjectName(input)).toEqual({ display_name: display, capability });
  });

  it.each(['Opsworks Migration', 'Operations', 'Ops - ', 'Website Redesign', 'Intelligent Routing', 'Internal Tools', ''])(
    'leaves %j unchanged',
    (input) => {
      expect(parseProjectName(input)).toEqual({ display_name: input, capability: null });
    },
  );
});
