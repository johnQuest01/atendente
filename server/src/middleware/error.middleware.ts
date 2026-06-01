import type { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors';
import { logger } from '../config/logger';
import { env } from '../config/env';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** 404 para rotas não registradas. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `Rota não encontrada: ${req.method} ${req.path}` },
  } satisfies ErrorBody);
}

/** Middleware de tratamento de erros centralizado. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  let statusCode = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Erro interno do servidor.';
  let details: unknown;

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof ZodError) {
    statusCode = 422;
    code = 'VALIDATION_ERROR';
    message = 'Dados inválidos.';
    details = err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
  } else if (err instanceof MulterError) {
    statusCode = 422;
    code = 'UPLOAD_ERROR';
    message = err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo excede o tamanho máximo.' : err.message;
  } else if (err instanceof Error) {
    message = err.message || message;
  }

  if (statusCode >= 500) {
    logger.error(`${req.method} ${req.path} -> ${statusCode}`, err);
  } else {
    logger.warn(`${req.method} ${req.path} -> ${statusCode}: ${message}`);
  }

  const body: ErrorBody = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  if (statusCode >= 500 && env.isDev && err instanceof Error) {
    body.error.details = { stack: err.stack };
  }

  res.status(statusCode).json(body);
}
