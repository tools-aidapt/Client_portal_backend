import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { UnauthorizedError } from '@common/errors/index.js';
import { ok } from '@common/utils/api-response.js';
import { reportsService } from './reports.service.js';

function tenantCtx(req: Request): { tenantId: string; userId: string } {
  if (!req.auth || !req.tenant) throw new UnauthorizedError();
  return { tenantId: req.tenant.id, userId: req.auth.user.id };
}

export const reportsController = {
  // --- MemberPro (tenant-scoped) ---
  async list(req: Request, res: Response): Promise<void> {
    res.status(StatusCodes.OK).json(ok(await reportsService.listForClient(tenantCtx(req).tenantId)));
  },

  async get(req: Request, res: Response): Promise<void> {
    const { tenantId, userId } = tenantCtx(req);
    res.status(StatusCodes.OK).json(ok(await reportsService.getForClient(tenantId, req.params.id!, userId)));
  },

  /** Streams the report as a PDF attachment, so the browser downloads it outright. */
  async downloadPdf(req: Request, res: Response): Promise<void> {
    const { tenantId, userId } = tenantCtx(req);
    const { pdf, filename } = await reportsService.renderPdf(tenantId, req.params.id!, userId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(pdf.length));
    res.status(StatusCodes.OK).end(pdf);
  },

  async pulse(req: Request, res: Response): Promise<void> {
    const { tenantId, userId } = tenantCtx(req);
    const { score, comment } = req.body as { score: number; comment?: string };
    const result = await reportsService.submitPulse(tenantId, req.params.id!, userId, score, comment);
    res.status(StatusCodes.OK).json(ok(result));
  },

  // --- Platform admin ---
  async create(req: Request, res: Response): Promise<void> {
    const b = req.body as {
      tenant_id: string;
      sprint_id?: string;
      title?: string;
      period_start?: string;
      period_end?: string;
      summary_md?: string;
      committed_count?: number;
      delivered_count?: number;
    };
    const report = await reportsService.createDraft({
      tenantId: b.tenant_id,
      sprintId: b.sprint_id,
      title: b.title,
      periodStart: b.period_start,
      periodEnd: b.period_end,
      summaryMd: b.summary_md,
      committedCount: b.committed_count,
      deliveredCount: b.delivered_count,
    });
    res.status(StatusCodes.CREATED).json(ok(report));
  },

  async publish(req: Request, res: Response): Promise<void> {
    if (!req.auth) throw new UnauthorizedError();
    const result = await reportsService.publish(req.params.id!, req.auth.user.id);
    res.status(StatusCodes.OK).json(ok(result));
  },
};
