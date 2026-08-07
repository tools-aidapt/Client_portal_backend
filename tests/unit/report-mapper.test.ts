import { describe, expect, it } from 'vitest';
import {
  cleanReportBody,
  isMonthlyReportDoc,
  mapReportDoc,
  mapReportSection,
  monthLabel,
  normalizePillar,
  parseReportPeriod,
  stripHeaderBlock,
  stripSection,
  sumTrackerCounts,
  type ReportSectionUpsert,
} from '@modules/sync/clickup/report-mapper.js';
import { partitionReportPages } from '@infra/clickup/client.js';
import type { ClickUpDoc, ClickUpDocPage } from '@infra/clickup/client.js';

function page(over: Partial<ClickUpDocPage> & { id: string }): ClickUpDocPage {
  return { doc_id: 'doc1', name: '', ...over };
}
function doc(over: Partial<ClickUpDoc> & { id: string }): ClickUpDoc {
  return { name: '', ...over };
}
function section(over: Partial<ReportSectionUpsert> = {}): ReportSectionUpsert {
  return {
    clickupPageId: 'p', pillar: 'operations', pillarLabel: 'AI Operations',
    pillarOwner: null, subtitle: null, bodyMd: null,
    committedCount: null, deliveredCount: null, sortOrder: 0, ...over,
  };
}

describe('parseReportPeriod', () => {
  const header = (period: string) =>
    `**Client:** Kenafric Group\n**Report Period:** ${period}\n**Date:** 31 July 2026\n`;

  // Every one of these is a verbatim string from the five live July 2026 Docs.
  it('reads an en-dash range (KEN)', () => {
    expect(parseReportPeriod({ rootContent: header('(01–31 July 2026)') })).toEqual({
      start: '2026-07-01', end: '2026-07-31', source: 'period_line',
    });
  });

  it('reads a plain-hyphen range (ABL, TCC)', () => {
    expect(parseReportPeriod({ rootContent: header('(01-31 July 2026)') })?.start).toBe('2026-07-01');
  });

  it('ignores the "Weeks 18 to 23" prefix and takes the parenthetical (JFX)', () => {
    // "18 to 23" is itself a valid-looking day range — the parenthetical must win.
    expect(parseReportPeriod({ rootContent: header('Weeks 18 to 23 (01-31 July 2026)') })).toEqual({
      start: '2026-07-01', end: '2026-07-31', source: 'period_line',
    });
  });

  it('falls back to the whole month when a prefixed value has no parenthetical', () => {
    // The ambiguity regression: must NOT read this as 18–23 July.
    expect(parseReportPeriod({ rootContent: header('Weeks 18 to 23 July 2026') })).toEqual({
      start: '2026-07-01', end: '2026-07-31', source: 'period_line',
    });
  });

  it('handles a cross-month range without reading the year as a day', () => {
    expect(parseReportPeriod({ rootContent: header('28 July 2026 - 03 August 2026') })).toEqual({
      start: '2026-07-28', end: '2026-08-03', source: 'period_line',
    });
  });

  it('handles an ISO range', () => {
    expect(parseReportPeriod({ rootContent: header('2026-07-01 to 2026-07-31') })?.end).toBe('2026-07-31');
  });

  it('falls back to the Date line, taking that whole month', () => {
    expect(parseReportPeriod({ rootContent: '**Date:** 31 July 2026\n' })).toEqual({
      start: '2026-07-01', end: '2026-07-31', source: 'date_line',
    });
  });

  it('falls back to the doc name when the Doc is empty (TRO)', () => {
    // Trojan's Doc has one page with an empty name and no content at all.
    expect(parseReportPeriod({ rootContent: '', docName: 'TRO - Report - JULY 2026' })).toEqual({
      start: '2026-07-01', end: '2026-07-31', source: 'doc_name',
    });
  });

  it('falls back to the root page name (legacy KEN doc)', () => {
    expect(
      parseReportPeriod({
        rootContent: '',
        docName: 'KEN - Monthly Reports',
        rootPageName: 'Kenafric Monthly Report 1 - 31st July 2026',
      }),
    ).toEqual({ start: '2026-07-01', end: '2026-07-31', source: 'page_name' });
  });

  it('handles a NBSP-separated header line', () => {
    expect(parseReportPeriod({ rootContent: '**Report\u00A0Period:**\u00A0(01-31 July 2026)' })?.start)
      .toBe('2026-07-01');
  });

  it('returns null rather than guessing when nothing is parseable', () => {
    expect(parseReportPeriod({ rootContent: 'no dates here', docName: 'Untitled' })).toBeNull();
    expect(parseReportPeriod({})).toBeNull();
  });

  it('rejects an impossible date and an inverted range', () => {
    expect(parseReportPeriod({ rootContent: header('(01-31 February 2026)') })?.end).not.toBe('2026-02-31');
    expect(parseReportPeriod({ rootContent: header('(31-01 July 2026)') })?.start).toBe('2026-07-01');
  });
});

describe('isMonthlyReportDoc', () => {
  it('accepts the real Doc names across all five clients', () => {
    for (const name of [
      'KEN - Report - JULY 2026',
      'ABL - Report - JULY 2026',
      'JFX - Report - July 2026',
      'TCC - Report - JULY 2026',
      'TRO - Report - JULY 2026',
    ]) {
      expect(isMonthlyReportDoc(name), name).toBe(true);
    }
  });

  it('rejects a leftover with no month in its name', () => {
    // Kenafric's "KEN - Monthly Reports" was a duplicate of the real July Doc
    // sitting in the same folder, and syncing it gave the client two identical
    // July entries.
    expect(isMonthlyReportDoc('KEN - Monthly Reports')).toBe(false);
    expect(isMonthlyReportDoc('ABL - Monthly Reports')).toBe(false);
  });

  it('rejects anything that is not a report', () => {
    expect(isMonthlyReportDoc('Project Pack')).toBe(false);
    expect(isMonthlyReportDoc('Meeting notes - July 2026')).toBe(false);
    expect(isMonthlyReportDoc('')).toBe(false);
    expect(isMonthlyReportDoc(null)).toBe(false);
  });

  it('tolerates a different word order for a future month', () => {
    expect(isMonthlyReportDoc('KEN - August 2026 Report')).toBe(true);
  });
});

describe('partitionReportPages', () => {
  it('splits the root page from its pillar children in document order', () => {
    const root = page({ id: 'root', name: 'KEN - Report - JULY 2026' });
    const kids = [
      page({ id: 'a', name: 'AI Operations', parent_page_id: 'root' }),
      page({ id: 'b', name: 'Intelligence', parent_page_id: 'root' }),
      page({ id: 'c', name: 'Enablement', parent_page_id: 'root' }),
    ];
    const out = partitionReportPages([{ ...root, pages: kids }]);
    expect(out.root?.id).toBe('root');
    expect(out.sections.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(out.extraRoots).toEqual([]);
    expect(out.orphans).toEqual([]);
  });

  it('ignores order_index, which is not a dependable sort key', () => {
    const root = page({ id: 'root', order_index: 3 });
    const kids = [
      page({ id: 'a', parent_page_id: 'root', order_index: 9 }),
      page({ id: 'b', parent_page_id: 'root', order_index: 2 }),
    ];
    expect(partitionReportPages([{ ...root, pages: kids }]).sections.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('surfaces extra roots and grandchildren instead of dropping them', () => {
    const out = partitionReportPages([
      { ...page({ id: 'root' }), pages: [
        { ...page({ id: 'a', parent_page_id: 'root' }), pages: [page({ id: 'deep', parent_page_id: 'a' })] },
      ] },
      page({ id: 'root2' }),
    ]);
    expect(out.extraRoots.map((p) => p.id)).toEqual(['root2']);
    expect(out.orphans.map((p) => p.id)).toEqual(['deep']);
  });

  it('handles the empty Doc (TRO)', () => {
    const out = partitionReportPages([page({ id: 'only', name: '', content: '' })]);
    expect(out.root?.id).toBe('only');
    expect(out.sections).toEqual([]);
  });
});

describe('body cleanup', () => {
  it('strips the repeated header metadata block but keeps the scope line', () => {
    const md = [
      '**Pillar:** AI Operations',
      '**Client:** Kenafric Group',
      '**Date:** 31 July 2026',
      '',
      '_Scope in this engagement: AI-driven business automation._',
      '',
      '## 1. What We Did',
    ].join('\n');
    const out = stripHeaderBlock(md);
    expect(out).not.toContain('**Client:**');
    expect(out).toContain('_Scope in this engagement');
    expect(out).toContain('## 1. What We Did');
  });

  it('drops a thematic break left stranded at the top', () => {
    expect(stripHeaderBlock('**Client:** X\n\n* * *\n\n## Executive Summary').startsWith('##')).toBe(true);
  });

  it('removes the Deep-Dive Links section up to the next heading', () => {
    const md = [
      '## Consolidated Risks', 'risk text', '',
      '## Deep-Dive Links', '*   [AI Operations](https://app.clickup.com/x)', '',
      '## Overall Gantt', 'gantt text',
    ].join('\n');
    const out = stripSection(md, /Deep[-\s]?Dive\s+Links/i);
    expect(out).not.toContain('Deep-Dive Links');
    expect(out).not.toContain('app.clickup.com');
    expect(out).toContain('## Consolidated Risks');
    expect(out).toContain('## Overall Gantt');
  });

  it('leaves markdown alone when there is no such section', () => {
    expect(stripSection('## A\ntext', /Deep-Dive/i)).toBe('## A\ntext');
  });

  it('returns null for an empty body', () => {
    expect(cleanReportBody('')).toBeNull();
    expect(cleanReportBody(null)).toBeNull();
  });
});

describe('normalizePillar', () => {
  it('maps the ClickUp page names onto the capability enum', () => {
    expect(normalizePillar('AI Operations')).toBe('operations');
    expect(normalizePillar('Intelligence')).toBe('intelligence');
    expect(normalizePillar('Enablement')).toBe('enablement');
  });

  it('returns null for anything else rather than guessing', () => {
    expect(normalizePillar('Appendix')).toBeNull();
    expect(normalizePillar('')).toBeNull();
    expect(normalizePillar(null)).toBeNull();
  });
});

describe('mapReportSection', () => {
  const content = [
    '**Pillar:** AI Operations',
    '**Pillar Owner:** Muhammad Ateeb',
    '**Date:** 31 July 2026',
    '',
    '## 3. Action Item Tracker',
    '',
    '| # | Action Item | Status |',
    '| ---| ---| --- |',
    '| 1 | Ship it | ✅ Done |',
    '| 2 | Plan it | 🔄 In Progress |',
  ].join('\n');

  it('reads the pillar, owner, counts and subtitle', () => {
    const out = mapReportSection(page({ id: 'pg1', name: 'AI Operations', content, sub_title: 'Campaign platform' }), 2);
    expect(out).toMatchObject({
      clickupPageId: 'pg1',
      pillar: 'operations',
      pillarLabel: 'AI Operations',
      pillarOwner: 'Muhammad Ateeb',
      subtitle: 'Campaign platform',
      committedCount: 2,
      deliveredCount: 1,
      sortOrder: 2,
    });
    expect(out.bodyMd).not.toContain('**Pillar Owner:**');
  });

  it('falls back to the page name when the body has no Pillar line', () => {
    expect(mapReportSection(page({ id: 'p', name: 'Enablement', content: 'text' }), 0).pillarLabel)
      .toBe('Enablement');
  });
});

describe('sumTrackerCounts', () => {
  it('adds up the pillar trackers', () => {
    expect(sumTrackerCounts([
      section({ committedCount: 13, deliveredCount: 1 }),
      section({ committedCount: 27, deliveredCount: 6 }),
    ])).toEqual({ committed: 40, delivered: 7 });
  });

  it('ignores sections with no tracker', () => {
    expect(sumTrackerCounts([
      section({ committedCount: 5, deliveredCount: 2 }),
      section({ committedCount: null, deliveredCount: null }),
    ])).toEqual({ committed: 5, delivered: 2 });
  });

  it('returns null, not zero, when nothing was tracked at all', () => {
    // "nobody tracked anything" must not read as "everything came to zero".
    expect(sumTrackerCounts([section()])).toEqual({ committed: null, delivered: null });
    expect(sumTrackerCounts([])).toEqual({ committed: null, delivered: null });
  });
});

describe('mapReportDoc', () => {
  const period = { start: '2026-07-01', end: '2026-07-31', source: 'period_line' as const };

  it('maps a populated Doc to a published report', () => {
    const out = mapReportDoc({
      tenantId: 't1',
      doc: doc({ id: 'd1', name: 'KEN - Report - JULY 2026', date_updated: 1786094232414 }),
      rootPage: page({ id: 'root', name: 'KEN - Report - JULY 2026', content: '## Executive Summary\n\nAll good.' }),
      period,
      sections: [section({ committedCount: 3, deliveredCount: 1 })],
    });
    expect(out).toMatchObject({
      tenantId: 't1',
      clickupDocId: 'd1',
      clickupPageId: 'root',
      title: 'KEN - Report - JULY 2026',
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
      committedCount: 3,
      deliveredCount: 1,
      status: 'published',
      // the month it covers, not when ClickUp last touched it
      publishedAt: '2026-07-31T00:00:00.000Z',
    });
    expect(out.docUpdatedAt).toBe(new Date(1786094232414).toISOString());
  });

  it('keeps an empty Doc as a draft so no client sees a blank report', () => {
    const out = mapReportDoc({
      tenantId: 't1',
      doc: doc({ id: 'd2', name: 'TRO - Report - JULY 2026' }),
      rootPage: page({ id: 'only', name: '', content: '' }),
      period,
      sections: [],
    });
    expect(out.status).toBe('draft');
    expect(out.summaryMd).toBeNull();
    expect(out.committedCount).toBeNull();
    // Title must never be '' — the column is not null and the page name is empty.
    expect(out.title).toBe('TRO - Report - JULY 2026');
  });

  it('never produces an empty title', () => {
    const out = mapReportDoc({
      tenantId: 't1', doc: doc({ id: 'd3', name: '' }),
      rootPage: page({ id: 'r', name: '' }), period, sections: [],
    });
    expect(out.title).toBe('Report — July 2026');
  });
});

describe('monthLabel', () => {
  it('names the month of a period end', () => {
    expect(monthLabel('2026-07-31')).toBe('July 2026');
  });
});
