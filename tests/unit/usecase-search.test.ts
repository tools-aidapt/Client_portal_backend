import { describe, expect, it } from 'vitest';
import { toTsQuery } from '@modules/usecases/usecases.service.js';
import { parseCaseStudySections } from '@modules/sync/clickup/usecase-mapper.js';

describe('toTsQuery', () => {
  it('prefix-matches the last term so search works while typing', () => {
    expect(toTsQuery('insur')).toBe('insur:*');
    expect(toTsQuery('freight invoice')).toBe('freight & invoice:*');
  });

  it('ANDs every term so more words narrow the result', () => {
    expect(toTsQuery('reduce manual invoice processing')).toBe('reduce & manual & invoice & processing:*');
  });

  it('strips tsquery operators instead of passing them through', () => {
    // Unsanitised, these would either be parsed as operators or throw a syntax
    // error inside to_tsquery.
    expect(toTsQuery('claims & !fraud')).toBe('claims & fraud:*');
    expect(toTsQuery('ai | agent:* & (fraud)')).toBe('ai & agent & fraud:*');
    // The apostrophe splits the word, and the lone "o" is dropped as noise.
    expect(toTsQuery("o'brien & co")).toBe('brien & co:*');
    // An expression made only of operators and single letters has nothing to
    // search on, so it degrades to browsing rather than erroring.
    expect(toTsQuery('a | b:* & (c)')).toBeNull();
  });

  it('returns null when there is nothing searchable, so the caller browses all', () => {
    expect(toTsQuery(undefined)).toBeNull();
    expect(toTsQuery(null)).toBeNull();
    expect(toTsQuery('')).toBeNull();
    expect(toTsQuery('   ')).toBeNull();
    expect(toTsQuery('+++---&&')).toBeNull();
    expect(toTsQuery('!@#$%^&*()')).toBeNull();
  });

  it('drops noise single characters but keeps a lone one-character search', () => {
    expect(toTsQuery('a invoice')).toBe('invoice:*');
    expect(toTsQuery('x')).toBe('x:*');
  });

  it('is case-insensitive', () => {
    expect(toTsQuery('WhatsApp')).toBe('whatsapp:*');
  });
});

describe('parseCaseStudySections', () => {
  const body = [
    'PROBLEM',
    '',
    'Claims take weeks.',
    '',
    'WHAT GETS BUILT',
    '',
    'An n8n automation that triages claims.',
    '',
    'CONNECTS TO',
    '',
    'Web form as intake channel',
    'Claude API for extraction',
    '',
    'DEFINITION OF DONE',
    '',
    'All claims acknowledged in 5 minutes.',
  ].join('\n');

  it('splits the ALL-CAPS convention (Automation / Wati lists)', () => {
    const s = parseCaseStudySections(body);
    expect(s.problem).toBe('Claims take weeks.');
    expect(s.solution).toBe('An n8n automation that triages claims.');
    expect(s.impact).toBe('All claims acknowledged in 5 minutes.');
  });

  it('turns CONNECTS TO into a list rather than prose', () => {
    expect(parseCaseStudySections(body).connectsTo).toEqual([
      'Web form as intake channel',
      'Claude API for extraction',
    ]);
  });

  it('strips bullet markers from the connects-to list', () => {
    const s = parseCaseStudySections('CONNECTS TO\n\n- Zoom API\n• Buffer\n* ClickUp');
    expect(s.connectsTo).toEqual(['Zoom API', 'Buffer', 'ClickUp']);
  });

  it('returns nulls for an unparseable body so the caller can fall back to body_md', () => {
    const s = parseCaseStudySections('Just a paragraph with no headings at all.');
    expect(s).toEqual({
      problem: null,
      solution: null,
      connectsTo: null,
      impact: null,
    });
  });

  it('ignores heading words that appear mid-sentence', () => {
    // "problem" here is prose, not a heading — only a line of its own counts.
    const s = parseCaseStudySections('PROBLEM\n\nThe real PROBLEM is scale, and WHAT GETS BUILT matters.');
    expect(s.problem).toBe('The real PROBLEM is scale, and WHAT GETS BUILT matters.');
    expect(s.solution).toBeNull();
  });

  it('handles empty and CRLF input', () => {
    expect(parseCaseStudySections('').problem).toBeNull();
    expect(parseCaseStudySections('PROBLEM\r\n\r\nSlow.').problem).toBe('Slow.');
  });

  // The five library lists were authored separately and use three different
  // heading conventions; all of them have to land in the same three slots.
  it('splits the colon convention (ClickUp list)', () => {
    const s = parseCaseStudySections(
      [
        'Problem:',
        'Certifications expire unexpectedly.',
        'Solution:',
        'Track expiry dates and auto-create renewal tasks.',
        'Integration:',
        'ClickUp native features.',
        'Success Criteria:',
        'Renewal tasks created 90 days prior.',
      ].join('\n'),
    );
    expect(s.problem).toBe('Certifications expire unexpectedly.');
    expect(s.solution).toBe('Track expiry dates and auto-create renewal tasks.');
    expect(s.impact).toBe('Renewal tasks created 90 days prior.');
  });

  it('splits the title-case convention (Snowflake list)', () => {
    const s = parseCaseStudySections(
      [
        'Outcome Intelligence Platform',
        '',
        'Problem',
        'Testimonials sit in DMs.',
        '',
        'Solution',
        'Build a Snowflake outcome platform.',
        '',
        'Snowflake Features Used',
        'Cortex Search',
        '',
        'Success Criteria',
        'Outcome archive is searchable.',
        '',
        'Estimated Build Time',
        '3 weeks',
      ].join('\n'),
    );
    expect(s.problem).toBe('Testimonials sit in DMs.');
    expect(s.solution).toBe('Build a Snowflake outcome platform.');
    // Must stop at "Estimated Build Time" rather than swallowing it.
    expect(s.impact).toBe('Outcome archive is searchable.');
  });

  it('maps Purpose to Solution for workbook studies (Sigma list)', () => {
    const s = parseCaseStudySections(
      ['Purpose', 'Sigma workbook for marketing.', '', 'Data Model', 'fct_outcomes', '', 'Success Criteria', 'Adopted by sales.'].join(
        '\n',
      ),
    );
    expect(s.problem).toBeNull(); // Sigma studies rarely state a problem
    expect(s.solution).toBe('Sigma workbook for marketing.');
    expect(s.impact).toBe('Adopted by sales.');
  });

  it('does not let an unsurfaced heading leak into the previous section', () => {
    const s = parseCaseStudySections('Solution\nDo the thing.\nMEA Context\nRegional notes here.');
    expect(s.solution).toBe('Do the thing.');
  });

  it('handles descriptions whose newlines arrive escaped as literal backslash-n', () => {
    // Some ClickUp bodies come through this way, which would otherwise collapse
    // into a single line and match no headings at all.
    const s = parseCaseStudySections(
      'Problem: Slow reporting.\\n\\nSolution: Automate it.\\n\\nSuccess Criteria: Reports in a day.',
    );
    // Heading and body share one line here, so the label is stripped off.
    expect(s.problem).toBe('Slow reporting.');
    expect(s.solution).toBe('Automate it.');
    expect(s.impact).toBe('Reports in a day.');
  });
});
