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
