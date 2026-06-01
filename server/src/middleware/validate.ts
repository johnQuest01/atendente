import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { type AnyZodObject, ZodError, type ZodTypeAny } from 'zod';
import { AppError } from '../utils/errors';

interface Schemas {
  body?: ZodTypeAny;
  query?: AnyZodObject;
  params?: AnyZodObject;
}

/**
 * Middleware de validação Zod. Substitui req.body/query/params pelos
 * dados já parseados e tipados. Lança AppError 422 em caso de falha.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.query) req.query = schemas.query.parse(req.query) as Request['query'];
      if (schemas.params) req.params = schemas.params.parse(req.params) as Request['params'];
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const details = err.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        }));
        next(new AppError('Dados inválidos.', 422, 'VALIDATION_ERROR', details));
        return;
      }
      next(err);
    }
  };
}
