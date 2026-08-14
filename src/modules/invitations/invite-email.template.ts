/**
 * The Partner Portal invite copy. n8n delivers this; we own the wording so a
 * rewrite does not require editing the workflow.
 *
 * Merge fields match the "Email 2, rewritten" brief. The non-retainer access
 * line is an alternate, not an add-on: send it instead of the retainer
 * sentence when `accessEndDate` is set.
 */

export const INVITE_EMAIL_SUBJECT = 'Your Aidapt Partner Portal login';
export const INVITE_EMAIL_PREHEADER =
  'Set your password, see what you have access to, clear Level 1.';

/** Third product in the suite (Support Desk and LMS are named in the copy). */
export const DEFAULT_APP_3_NAME = 'Partner Portal';
export const DEFAULT_APP_3_LINE =
  'Your projects, sprints, monthly reports, and the work itself.';

export const DEFAULT_SUPPORT_EMAIL = 'support@aidapt.co';
export const DEFAULT_AIDAPT_LEAD_NAME = 'Hitesh Mahajan';
export const DEFAULT_AIDAPT_LEAD_TITLE = 'hitesh@aidapt.co';

export type InviteEmailVars = {
  firstName: string;
  portalUrl: string;
  loginEmail: string;
  trackName: string;
  app3Name: string;
  app3Line: string;
  companyName: string;
  /** When set, the non-retainer sentence replaces the open-ended access line. */
  accessEndDate: string | null;
  supportEmail: string;
  aidaptLeadName: string;
  aidaptLeadTitle: string | null;
};

export type RenderedInviteEmail = {
  subject: string;
  preheader: string;
  text: string;
  html: string;
};

/**
 * Best-effort given name from an email local-part, for "Hi {{first_name}},"
 * when the inviter did not supply one. Single-letter tokens (m.rehman) are
 * skipped so we do not greet someone as "Hi M,".
 */
export function guessFirstName(email: string): string {
  const local = (email.split('@')[0] ?? '').trim();
  const token = local.split(/[._+\-]/).find((part) => part.length >= 2);
  if (!token) return 'there';
  return token.charAt(0)!.toUpperCase() + token.slice(1).toLowerCase();
}

export function renderInviteEmail(vars: InviteEmailVars): RenderedInviteEmail {
  const accessLine = vars.accessEndDate
    ? `Your access runs through ${vars.accessEndDate}. Clear your first level well before then.`
    : `Your access runs for as long as Aidapt and ${vars.companyName} are working together.`;

  const signOffTitle = vars.aidaptLeadTitle
    ? `${vars.aidaptLeadTitle}, Aidapt`
    : 'Aidapt';

  const text = [
    `Hi ${vars.firstName},`,
    '',
    'You have a seat on the Aidapt Partner Portal. It is where your work with Aidapt lives, and where you learn to run it yourself.',
    '',
    'Get in',
    vars.portalUrl,
    `Username: ${vars.loginEmail}`,
    'Set your password and you are in.',
    '',
    'What you have been given access to',
    '',
    'Support Desk. Something broken, something confusing, something you want changed. Raise it here and watch it move. No chasing, no wondering who has it.',
    '',
    `LMS. Your track is ${vars.trackName}, starting at Level 1. Levels move as you finish modules and apply them to real work, not quizzes. Your team sees your progress and you see theirs. That is on purpose.`,
    '',
    `${vars.app3Name}. ${vars.app3Line}`,
    '',
    'Start here',
    'Set your password. Open the LMS. Finish Module 1.',
    '',
    accessLine,
    '',
    `Stuck on anything, reply here or write to ${vars.supportEmail}. A person answers.`,
    '',
    'Welcome in.',
    '',
    vars.aidaptLeadName,
    signOffTitle,
  ].join('\n');

  const html = renderHtml(vars, accessLine, signOffTitle);

  return {
    subject: INVITE_EMAIL_SUBJECT,
    preheader: INVITE_EMAIL_PREHEADER,
    text,
    html,
  };
}

function renderHtml(vars: InviteEmailVars, accessLine: string, signOffTitle: string): string {
  const firstName = escapeHtml(vars.firstName);
  const portalUrl = escapeHtml(vars.portalUrl);
  const loginEmail = escapeHtml(vars.loginEmail);
  const trackName = escapeHtml(vars.trackName);
  const app3Name = escapeHtml(vars.app3Name);
  const app3Line = escapeHtml(vars.app3Line);
  const access = escapeHtml(accessLine);
  const supportEmail = escapeHtml(vars.supportEmail);
  const leadName = escapeHtml(vars.aidaptLeadName);
  const leadTitle = escapeHtml(signOffTitle);
  const preheader = escapeHtml(INVITE_EMAIL_PREHEADER);

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(INVITE_EMAIL_SUBJECT)}</title></head>
<body style="margin:0;padding:0;background:#ffffff;color:#111111;font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.5;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
<div style="max-width:560px;margin:0 auto;padding:24px 16px;">
  <p>Hi ${firstName},</p>
  <p>You have a seat on the Aidapt Partner Portal. It is where your work with Aidapt lives, and where you learn to run it yourself.</p>
  <p><strong>Get in</strong><br>
    <a href="${portalUrl}">${portalUrl}</a><br>
    Username: ${loginEmail}<br>
    Set your password and you are in.</p>
  <p><strong>What you have been given access to</strong></p>
  <p>Support Desk. Something broken, something confusing, something you want changed. Raise it here and watch it move. No chasing, no wondering who has it.</p>
  <p>LMS. Your track is ${trackName}, starting at Level 1. Levels move as you finish modules and apply them to real work, not quizzes. Your team sees your progress and you see theirs. That is on purpose.</p>
  <p>${app3Name}. ${app3Line}</p>
  <p><strong>Start here</strong><br>
    Set your password. Open the LMS. Finish Module 1.</p>
  <p>${access}</p>
  <p>Stuck on anything, reply here or write to <a href="mailto:${supportEmail}">${supportEmail}</a>. A person answers.</p>
  <p>Welcome in.</p>
  <p>${leadName}<br>${leadTitle}</p>
</div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
