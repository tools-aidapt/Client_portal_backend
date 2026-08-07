import { BadRequestError, ConflictError, NotFoundError } from '@common/errors/index.js';
import { reportsRepo, type CreateDraftInput } from './reports.repository.js';
import { renderReportPdf, reportPdfFilename, type ReportPdfInput } from './report-pdf.js';

export interface CreateReportRequest {
  tenantId: string;
  sprintId?: string;
  title?: string;
  periodStart?: string;
  periodEnd?: string;
  summaryMd?: string;
  committedCount?: number;
  deliveredCount?: number;
}

export const reportsService = {
  async listForClient(tenantId: string) {
    return { items: await reportsRepo.listForClient(tenantId) };
  },

  async getForClient(tenantId: string, id: string, userId: string) {
    const report = await reportsRepo.getForClient(tenantId, id, userId);
    if (!report) throw new NotFoundError('Report not found');
    return report;
  },

  /**
   * Create a draft. When a sprint is given, missing title/period/counts are
   * seeded from the sprint and its task cache (design §10.4).
   */
  async createDraft(req: CreateReportRequest) {
    let { title, periodStart, periodEnd, committedCount, deliveredCount } = req;

    if (req.sprintId) {
      const meta = await reportsRepo.getSprintMeta(req.sprintId);
      if (!meta) throw new BadRequestError('Sprint not found');
      title ??= meta.name;
      periodStart ??= meta.starts_on ?? undefined;
      periodEnd ??= meta.ends_on ?? undefined;
      if (committedCount == null || deliveredCount == null) {
        const counts = await reportsRepo.sprintCounts(req.tenantId, req.sprintId);
        committedCount ??= counts.committed;
        deliveredCount ??= counts.delivered;
      }
    }

    if (!title || !periodStart || !periodEnd) {
      throw new BadRequestError('title, period_start and period_end are required (or provide a sprint_id)');
    }

    const input: CreateDraftInput = {
      tenantId: req.tenantId,
      sprintId: req.sprintId ?? null,
      title,
      periodStart,
      periodEnd,
      summaryMd: req.summaryMd ?? null,
      committedCount: committedCount ?? null,
      deliveredCount: deliveredCount ?? null,
    };
    return reportsRepo.createDraft(input);
  },

  /**
   * The report as a PDF. Reuses `getForClient`, so the same tenant + status gate
   * applies — a client can only export a report they are allowed to read.
   */
  async renderPdf(tenantId: string, id: string, userId: string) {
    const report = (await this.getForClient(tenantId, id, userId)) as unknown as ReportPdfInput & {
      tenantName?: string;
    };
    const tenantName = await reportsRepo.getTenantName(tenantId);
    const pdf = await renderReportPdf({ ...report, tenantName: tenantName ?? 'Aidapt client' });
    return { pdf, filename: reportPdfFilename(report.title) };
  },

  async publish(id: string, publishedBy: string) {
    const result = await reportsRepo.publish(id, publishedBy);
    if (!result) throw new NotFoundError('Report not found');
    if ((result as { alreadyPublished?: boolean }).alreadyPublished) {
      throw new ConflictError('Report is already published');
    }
    return result;
  },

  async submitPulse(tenantId: string, reportId: string, userId: string, score: number, comment?: string) {
    const report = await reportsRepo.getById(reportId);
    if (!report || report.tenant_id !== tenantId) throw new NotFoundError('Report not found');
    if (report.status !== 'published') throw new BadRequestError('Pulse can only be submitted on a published report');
    return reportsRepo.upsertPulse(reportId, userId, score, comment ?? null);
  },
};
