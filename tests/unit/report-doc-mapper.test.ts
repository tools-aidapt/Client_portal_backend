import { describe, expect, it } from 'vitest';
import {
  deriveReportPeriods,
  mapReportPage,
  normalizeDocMarkdown,
  parseReportPageTitle,
  parseTrackerCounts,
} from '@modules/sync/clickup/mapper.js';
import type { ClickUpDocPage } from '@infra/clickup/client.js';

function page(name: string, content = '', id = name): ClickUpDocPage {
  return { id, doc_id: 'doc1', name, content };
}

describe('parseReportPageTitle', () => {
  it('reads the number and date off a report page', () => {
    expect(parseReportPageTitle('Report 9: Bi-Monthly Status Report - 02 July 2026')).toEqual({
      number: 9,
      date: '2026-07-02',
    });
  });

  it('accepts an ordinal suffix on the day', () => {
    expect(parseReportPageTitle('Report 1: Monthly Report - 31st July 2026')?.date).toBe('2026-07-31');
  });

  it('rejects pages that are not client reports', () => {
    // Nested under Report 3 in the real Doc — internal, must never sync.
    expect(parseReportPageTitle('Internal Status Briefing — 15 April 2026 (Midday Update)')).toBeNull();
    expect(parseReportPageTitle('00 — How to Use This Project Pack')).toBeNull();
    expect(parseReportPageTitle('Project Updates')).toBeNull();
  });

  it('rejects a report page with no parseable date', () => {
    expect(parseReportPageTitle('Report 10: Bi-Monthly Status Report')).toBeNull();
  });

  it('rejects an impossible calendar date', () => {
    expect(parseReportPageTitle('Report 2: Status - 31 February 2026')).toBeNull();
  });
});

describe('parseTrackerCounts', () => {
  // Report 1's tracker: 4 columns, no Source/Due.
  const reportOneShape = `
## 3\\. Action Item Tracker

| # | Action Item | Owner | Status |
| ---| ---| ---| --- |
| 1 | Provision server | James | 🔄 In Progress |
| 2 | Confirm scope | All | ✅ Done |

## 4\\. Risks and Issues
`;

  // Report 9's tracker: Source and Due inserted, so Status moves position.
  const reportNineShape = `
## 3\\. Action Item Tracker

| # | Action Item | Owner | Source | Status | Due |
| ---| ---| ---| ---| ---| --- |
| 64 | Compile inventory | Narayanan | Report 5 | ✅ Done — scope locked | 02 Jul |
| 78 | Send fields doc | Sushil | Report 6 | 🔄 In Progress — carried | 15 Jul |
| 95 | Build KIL dashboard | Sushil | Report 9 | ⏳ Not Started | 25 Jul |

## 4\\. Risks and Issues

| # | Risk | Status |
| ---| ---| --- |
| 1 | Blocker cleared | ✅ Resolved |
| 2 | Another one cleared | ✅ Resolved |
`;

  it('counts every tracked action as committed and ✅ rows as delivered', () => {
    expect(parseTrackerCounts(reportOneShape)).toEqual({ committed: 2, delivered: 1 });
  });

  it('locates the status column by header name, not position', () => {
    expect(parseTrackerCounts(reportNineShape)).toEqual({ committed: 3, delivered: 1 });
  });

  it('ignores ✅ in the Risks table that follows the tracker', () => {
    // Two ✅ Resolved risks must not inflate delivered beyond the one ✅ action.
    expect(parseTrackerCounts(reportNineShape)?.delivered).toBe(1);
  });

  it('returns null when there is no tracker to read', () => {
    expect(parseTrackerCounts('## 1. What We Did\n\nProse only.')).toBeNull();
    expect(parseTrackerCounts('## 3. Action Item Tracker\n\nNone this period.\n')).toBeNull();
  });
});

describe('deriveReportPeriods', () => {
  const pages = [
    page('Handbook'),
    page('Report 2: Bi-Monthly Status Report - 22 March 2026'),
    page('Report 1: Bi-Monthly Status Report - 08 March 2026'),
    page('Internal Status Briefing — 15 April 2026 (Midday Update)'),
    page('Report 3: Bi-Monthly Status Report - 05 April 2026'),
  ];

  it('orders reports oldest-first and drops non-report pages', () => {
    expect(deriveReportPeriods(pages).map((r) => r.page.name)).toEqual([
      'Report 1: Bi-Monthly Status Report - 08 March 2026',
      'Report 2: Bi-Monthly Status Report - 22 March 2026',
      'Report 3: Bi-Monthly Status Report - 05 April 2026',
    ]);
  });

  it('starts each period the day after the previous report, leaving no gap or overlap', () => {
    const [first, second, third] = deriveReportPeriods(pages);
    expect(second!.periodStart).toBe('2026-03-09'); // day after Report 1
    expect(second!.periodEnd).toBe('2026-03-22');
    expect(third!.periodStart).toBe('2026-03-23'); // day after Report 2
    // The first report has no predecessor — fall back to the 14-day cadence.
    expect(first!.periodStart).toBe('2026-02-23');
    expect(first!.periodEnd).toBe('2026-03-08');
  });
});

describe('normalizeDocMarkdown', () => {
  it('hard-breaks the report header so it does not render as one run-on line', () => {
    const header = [
      '**Project:** AI Data Cloud (Snowflake Implementation)',
      '**Client:** Kenafric Group',
      '**Date:** 02 July 2026',
    ].join('\r\n');
    expect(normalizeDocMarkdown(header)).toBe(
      '**Project:** AI Data Cloud (Snowflake Implementation)  \n' +
        '**Client:** Kenafric Group  \n' +
        '**Date:** 02 July 2026',
    );
  });

  it('normalises CRLF to LF', () => {
    expect(normalizeDocMarkdown('# Heading\r\n\r\nBody.\r\n')).toBe('# Heading\n\nBody.\n');
  });

  it('leaves tables, lists and headings byte-for-byte alone', () => {
    const md = [
      '## 3. Action Item Tracker',
      '',
      '| # | Status |',
      '| ---| --- |',
      '| 1 | ✅ Done |',
      '',
      '- [ ] Ship the dashboard',
      '- [x] Close the blocker',
      '',
      '* * *',
    ].join('\n');
    expect(normalizeDocMarkdown(md)).toBe(md);
  });

  it('does not hard-break a single-line paragraph', () => {
    expect(normalizeDocMarkdown('Just one line.\n\nAnd another.')).toBe('Just one line.\n\nAnd another.');
  });

  it('never touches content inside a fenced code block', () => {
    // Report 2's architecture diagram ships pre-fenced from ClickUp; adding hard
    // breaks inside it would render literal trailing spaces in the code block.
    const md = [
      '```markdown',
      'SAP S/4 HANA 1909',
      '        ↓ HANA Cloud Connector',
      '   Data Sphere',
      '```',
    ].join('\n');
    expect(normalizeDocMarkdown(md)).toBe(md);
  });

  it('is idempotent', () => {
    const md = '**A:** one\r\n**B:** two\r\n\r\n| x |\n| --- |\n| y |\n';
    const once = normalizeDocMarkdown(md);
    expect(normalizeDocMarkdown(once)).toBe(once);
  });
});

describe('mapReportPage', () => {
  it('maps a page onto the portal.reports columns', () => {
    const p = page(
      'Report 9: Bi-Monthly Status Report - 02 July 2026',
      '## 3. Action Item Tracker\n\n| # | Status |\n| ---| --- |\n| 1 | ✅ Done |\n',
      '8ckbtec-191412',
    );
    expect(
      mapReportPage(p, {
        tenantId: 'tenant-1',
        docId: '8ckbtec-180492',
        periodStart: '2026-06-19',
        periodEnd: '2026-07-02',
      }),
    ).toEqual({
      tenantId: 'tenant-1',
      clickupDocId: '8ckbtec-180492',
      clickupPageId: '8ckbtec-191412',
      title: 'Report 9: Bi-Monthly Status Report - 02 July 2026',
      periodStart: '2026-06-19',
      periodEnd: '2026-07-02',
      summaryMd: p.content!.trim(),
      committedCount: 1,
      deliveredCount: 1,
      // The issue date, not the page's ClickUp date_created — Reports 1-5 were
      // backfilled in one batch and would otherwise all share a wrong date.
      publishedAt: '2026-07-02T00:00:00.000Z',
    });
  });

  it('leaves counts null when the page has no tracker', () => {
    const mapped = mapReportPage(page('Report 1: Status - 08 March 2026', 'Prose only.'), {
      tenantId: 't',
      docId: 'd',
      periodStart: '2026-02-23',
      periodEnd: '2026-03-08',
    });
    expect(mapped.committedCount).toBeNull();
    expect(mapped.deliveredCount).toBeNull();
  });
});
