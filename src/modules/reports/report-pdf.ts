import { Marked } from 'marked';
import puppeteer, { type Browser } from 'puppeteer-core';
import { config } from '@config/index.js';
import { AppError } from '@common/errors/index.js';
import { logger } from '@infra/logger/index.js';

/**
 * Server-rendered PDF for a monthly report.
 *
 * The portal used to hand the report to `window.print()`, which cannot download
 * without the browser's print dialog — no browser allows silent printing. So the
 * file is generated here instead and streamed back as an attachment.
 *
 * Headless Chrome rather than a JS PDF library: report bodies are GFM tables
 * with paragraph-length cells, and the rasterising libraries (jsPDF +
 * html2canvas) produce blurry text and break tables mid-row. Rendering the same
 * HTML/CSS the portal uses keeps the PDF vector, selectable and paginated.
 */

/** Raw HTML is dropped, matching the frontend's deliberate no-`rehype-raw` stance. */
const md = new Marked({ gfm: true, breaks: false });
md.use({ renderer: { html: () => '' } });

export interface ReportPdfSection {
  pillar_label: string;
  pillar_owner: string | null;
  subtitle: string | null;
  body_md: string | null;
  committed_count: number | null;
  delivered_count: number | null;
}

export interface ReportPdfInput {
  title: string;
  period_start: string;
  period_end: string;
  committed_count: number | null;
  delivered_count: number | null;
  summary_md: string | null;
  sections: ReportPdfSection[];
  tenantName: string;
}

/** Escape a value destined for HTML text (titles, owners — never markdown). */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * A standalone print document. Deliberately NOT the SPA route: driving the app
 * headlessly would mean minting a session for the browser and waiting on client
 * fetches, and any frontend change could silently break the export. This renders
 * from the same rows the API returns.
 */
export function buildReportHtml(r: ReportPdfInput): string {
  const tile = (label: string, value: number | null) =>
    `<div class="tile"><span class="tile-v">${value ?? '—'}</span><span class="tile-l">${label}</span></div>`;

  const rolled =
    r.committed_count != null && r.delivered_count != null ? r.committed_count - r.delivered_count : null;

  const sections = r.sections
    .map(
      (s) => `
      <section class="pillar">
        <h1 class="pillar-title">${esc(s.pillar_label)}</h1>
        <p class="pillar-meta">
          ${s.pillar_owner ? `Led by ${esc(s.pillar_owner)}` : ''}
          ${s.committed_count != null ? `<span class="count">${s.delivered_count ?? 0}/${s.committed_count} delivered</span>` : ''}
        </p>
        ${s.subtitle ? `<p class="pillar-sub">${esc(s.subtitle)}</p>` : ''}
        ${s.body_md ? md.parse(s.body_md) : ''}
      </section>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(r.title)}</title><style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font-family: Inter, "Segoe UI", system-ui, sans-serif; font-size: 10.5pt;
         line-height: 1.55; color: #5A6B72; }
  .masthead { display: flex; justify-content: space-between; align-items: baseline;
              border-bottom: 1px solid rgba(17,168,160,.25); padding-bottom: 8px; margin-bottom: 18px; }
  .brand { font-weight: 800; font-size: 12pt; color: #0A1A22; }
  .kicker { font-size: 8.5pt; color: #5A6B72; }
  .period { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 8.5pt; }
  h1.doc { font-size: 19pt; font-weight: 800; color: #0A1A22; margin: 2px 0 14px; line-height: 1.2; }
  .tiles { display: flex; border: 1px solid #E6EAEC; border-radius: 8px; overflow: hidden; margin-bottom: 22px; }
  .tile { flex: 1; text-align: center; padding: 10px 6px; border-right: 1px solid #E6EAEC; background: #F7F9FA; }
  .tile:last-child { border-right: 0; }
  .tile-v { display: block; font-size: 17pt; font-weight: 700; color: #0A1A22;
            font-family: "IBM Plex Mono", ui-monospace, monospace; }
  .tile-l { display: block; font-size: 8pt; }
  /* Each pillar starts a fresh page — they are separate tabs on screen and
     should read as separate chapters on paper. */
  section.pillar { break-before: page; }
  .pillar-title { font-size: 15pt; font-weight: 800; color: #0A1A22; margin: 0 0 2px; }
  .pillar-meta { font-size: 9pt; margin: 0 0 2px; }
  .pillar-meta .count { font-family: "IBM Plex Mono", ui-monospace, monospace; color: #9CA3AF; margin-left: 10px; }
  .pillar-sub { font-size: 9.5pt; margin: 0 0 14px; padding-bottom: 10px; border-bottom: 1px solid #F3F5F7; }
  h1, h2, h3, h4 { break-after: avoid-page; }
  h2 { font-size: 13pt; font-weight: 800; color: #0A1A22; margin: 20px 0 8px;
       border-bottom: 1px solid #F3F5F7; padding-bottom: 5px; }
  h3 { font-size: 11pt; font-weight: 700; color: #0A1A22; margin: 16px 0 6px; }
  h4 { font-size: 9pt; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: #9CA3AF; }
  p { margin: 8px 0; }
  ul, ol { margin: 8px 0; padding-left: 18px; }
  li { margin: 3px 0; break-inside: avoid; }
  strong { color: #0A1A22; font-weight: 700; }
  a { color: #11A8A0; text-decoration: none; }
  hr { border: 0; border-top: 1px solid #F3F5F7; margin: 16px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 8.5pt; margin: 12px 0; }
  thead { display: table-header-group; background: #F3F5F7; }
  th { text-align: left; font-weight: 700; color: #0A1A22; padding: 6px 8px; border-bottom: 1px solid rgba(17,168,160,.2); }
  td { padding: 6px 8px; border-bottom: 1px solid #F3F5F7; vertical-align: top; }
  tr { break-inside: avoid; }
  img { max-width: 100%; }
  code { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 8.5pt;
         background: #F3F5F7; padding: 1px 4px; border-radius: 3px; }
  pre { background: #F3F5F7; padding: 10px; border-radius: 8px; overflow: hidden;
        white-space: pre-wrap; break-inside: avoid; }
  input[type=checkbox] { margin-right: 6px; }
</style></head><body>
  <div class="masthead"><span class="brand">Aidapt</span><span class="kicker">Delivery status report · ${esc(r.tenantName)}</span></div>
  <p class="period">${fmtDate(r.period_start)} – ${fmtDate(r.period_end)}</p>
  <h1 class="doc">${esc(r.title)}</h1>
  <div class="tiles">${tile('Committed', r.committed_count)}${tile('Delivered', r.delivered_count)}${tile('Rolled', rolled)}</div>
  ${r.summary_md ? md.parse(r.summary_md) : ''}
  ${sections}
</body></html>`;
}

/**
 * Where Chrome lives. In the container it is the Alpine `chromium` package (set
 * via env in the Dockerfile); on a dev machine we fall back to the usual install
 * paths so nobody has to configure anything to try the button locally.
 */
const FALLBACK_CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

async function resolveChrome(): Promise<string> {
  if (config.pdf.chromePath) return config.pdf.chromePath;
  const { access } = await import('node:fs/promises');
  for (const path of FALLBACK_CHROME) {
    try {
      await access(path);
      return path;
    } catch {
      /* try the next one */
    }
  }
  throw new AppError(
    'No Chrome/Chromium found for PDF export — set PUPPETEER_EXECUTABLE_PATH',
    503,
    'PDF_NO_BROWSER',
  );
}

/**
 * One browser for the process, not one per request: a cold Chrome launch is
 * ~300ms and several concurrent launches will exhaust a small container's
 * memory. Pages are still per-request and always closed.
 */
let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  const existing = await browserPromise?.catch(() => null);
  if (existing?.connected) return existing;
  browserPromise = resolveChrome().then((executablePath) =>
    puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    }),
  );
  return browserPromise;
}

/** Close the shared browser on shutdown so the container exits cleanly. */
export async function closePdfBrowser(): Promise<void> {
  const browser = await browserPromise?.catch(() => null);
  browserPromise = null;
  await browser?.close().catch(() => undefined);
}

export async function renderReportPdf(input: ReportPdfInput): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // `load`, so embedded images (the ClickUp Gantt exports) get a chance to
    // arrive — but with a hard timeout, because some of those attachment URLs are
    // auth-gated and would otherwise hang the request rather than fail fast.
    await page.setContent(buildReportHtml(input), { waitUntil: 'load', timeout: 20_000 });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      // Margins come from the stylesheet's @page rule; setting them here too
      // would double them.
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate:
        '<div style="width:100%;font-size:7pt;color:#9CA3AF;padding:0 14mm;display:flex;justify-content:space-between;">' +
        `<span>${esc(input.title)}</span><span class="pageNumber"></span></div>`,
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** `KEN-Report-JULY-2026.pdf` — safe on every filesystem. */
export function reportPdfFilename(title: string): string {
  const slug = title.replace(/[^\w\d]+/g, '-').replace(/^-+|-+$/g, '') || 'report';
  return `${slug}.pdf`;
}

export { logger as pdfLogger };
