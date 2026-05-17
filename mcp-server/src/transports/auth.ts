/**
 * Bearer auth middleware with constant-time comparison (CI-11 / RNF04).
 */

import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

export function bearerAuth(expectedToken: string) {
  const expected = Buffer.from(expectedToken, 'utf8');

  return (req: Request, res: Response, next: NextFunction): void => {
    const header =
      req.header('authorization') ?? req.header('Authorization') ?? '';

    if (!header.startsWith('Bearer ')) {
      res.status(401).type('application/json').json({
        error: 'unauthorized',
        message: 'Authorization Bearer obrigatorio para chamadas ao MCP do help Sankhya.',
      });
      return;
    }

    const received = Buffer.from(header.slice('Bearer '.length).trim(), 'utf8');

    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      res.status(401).type('application/json').json({
        error: 'unauthorized',
        message: 'Token Bearer invalido.',
      });
      return;
    }

    next();
  };
}
