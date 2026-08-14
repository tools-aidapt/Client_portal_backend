import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AIDAPT_LEAD_NAME,
  DEFAULT_AIDAPT_LEAD_TITLE,
  DEFAULT_APP_3_LINE,
  DEFAULT_APP_3_NAME,
  DEFAULT_SUPPORT_EMAIL,
  INVITE_EMAIL_PREHEADER,
  INVITE_EMAIL_SUBJECT,
  guessFirstName,
  renderInviteEmail,
} from '@modules/invitations/invite-email.template.js';

const vars = {
  firstName: 'Sarah',
  portalUrl: 'https://portal.aidapt.co/register?token=abc',
  loginEmail: 'sarah@kenafric.com',
  trackName: 'Kenafric',
  app3Name: DEFAULT_APP_3_NAME,
  app3Line: DEFAULT_APP_3_LINE,
  companyName: 'Kenafric',
  accessEndDate: null as string | null,
  supportEmail: DEFAULT_SUPPORT_EMAIL,
  aidaptLeadName: DEFAULT_AIDAPT_LEAD_NAME,
  aidaptLeadTitle: DEFAULT_AIDAPT_LEAD_TITLE,
};

describe('guessFirstName', () => {
  it('uses the first substantial token of the local-part', () => {
    expect(guessFirstName('sarah.ahmed@kenafric.com')).toBe('Sarah');
    expect(guessFirstName('john@aidapt.co')).toBe('John');
  });

  it('skips a single-letter first token so m.rehman is not greeted as M', () => {
    expect(guessFirstName('m.rehman@aidapt.co')).toBe('Rehman');
  });

  it('falls back to there when nothing usable is in the local-part', () => {
    expect(guessFirstName('x@aidapt.co')).toBe('there');
    expect(guessFirstName('a.b@aidapt.co')).toBe('there');
  });
});

describe('renderInviteEmail', () => {
  it('uses the Partner Portal login subject and preheader', () => {
    const out = renderInviteEmail(vars);
    expect(out.subject).toBe(INVITE_EMAIL_SUBJECT);
    expect(out.preheader).toBe(INVITE_EMAIL_PREHEADER);
    expect(out.subject).toBe('Your Aidapt Partner Portal login');
    expect(out.preheader).toBe(
      'Set your password, see what you have access to, clear Level 1.',
    );
  });

  it('renders the rewritten invite copy with merge fields filled', () => {
    const { text } = renderInviteEmail(vars);
    expect(text).toContain('Hi Sarah,');
    expect(text).toContain(
      'You have a seat on the Aidapt Partner Portal. It is where your work with Aidapt lives, and where you learn to run it yourself.',
    );
    expect(text).toContain('Get in');
    expect(text).toContain('https://portal.aidapt.co/register?token=abc');
    expect(text).toContain('Username: sarah@kenafric.com');
    expect(text).toContain('Set your password and you are in.');
    expect(text).toContain('What you have been given access to');
    expect(text).toContain(
      'Support Desk. Something broken, something confusing, something you want changed. Raise it here and watch it move. No chasing, no wondering who has it.',
    );
    expect(text).toContain(
      'LMS. Your track is Kenafric, starting at Level 1. Levels move as you finish modules and apply them to real work, not quizzes. Your team sees your progress and you see theirs. That is on purpose.',
    );
    expect(text).toContain(`Partner Portal. ${DEFAULT_APP_3_LINE}`);
    expect(text).toContain('Start here');
    expect(text).toContain('Set your password. Open the LMS. Finish Module 1.');
    expect(text).toContain(
      'Your access runs for as long as Aidapt and Kenafric are working together.',
    );
    expect(text).not.toContain('Clear your first level well before then.');
    expect(text).toContain(
      'Stuck on anything, reply here or write to support@aidapt.co. A person answers.',
    );
    expect(text).toContain('Welcome in.');
    expect(text).toContain('Hitesh Mahajan');
    expect(text).toContain('hitesh@aidapt.co, Aidapt');
  });

  it('swaps in the non-retainer access line when an end date is set', () => {
    const { text } = renderInviteEmail({ ...vars, accessEndDate: '31 Dec 2026' });
    expect(text).toContain(
      'Your access runs through 31 Dec 2026. Clear your first level well before then.',
    );
    expect(text).not.toContain(
      'Your access runs for as long as Aidapt and Kenafric are working together.',
    );
  });

  it('omits a dangling comma on the sign-off when there is no title', () => {
    const { text } = renderInviteEmail({ ...vars, aidaptLeadTitle: null });
    expect(text).toContain('Hitesh Mahajan\nAidapt');
    expect(text).not.toContain(', Aidapt');
  });

  it('puts the preheader and login link in the html', () => {
    const { html } = renderInviteEmail(vars);
    expect(html).toContain(INVITE_EMAIL_PREHEADER);
    expect(html).toContain('href="https://portal.aidapt.co/register?token=abc"');
    expect(html).toContain('mailto:support@aidapt.co');
    expect(html).toContain('Hi Sarah,');
  });

  it('escapes html in merge fields so a name cannot break the markup', () => {
    const { html } = renderInviteEmail({
      ...vars,
      firstName: 'Sarah <script>',
      companyName: 'Kenafric & Co',
      accessEndDate: null,
    });
    expect(html).toContain('Sarah &lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});
