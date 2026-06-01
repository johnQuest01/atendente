import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Envolve handlers async para encaminhar rejeições ao middleware de erro,
 * evitando try/catch repetido em cada controller.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
