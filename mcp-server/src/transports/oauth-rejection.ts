/**
 * Reject OAuth discovery probes with JSON 404 — never HTML (MELHORES-PRATICAS
 * Sec 11.1.1 / RNF01).
 */

import type { Application } from 'express';

const OAUTH_PATHS = [
  '/register',
  '/.well-known/oauth-authorization-server',
  '/.well-known/openid-configuration',
  '/authorize',
  '/token',
];

export function attachOauthRejection(app: Application): void {
  for (const path of OAUTH_PATHS) {
    app.all(path, (_req, res) => {
      res.status(404).type('application/json').json({
        error: 'not_supported',
        message: 'MCP Sankhya Ajuda usa Bearer token, nao OAuth.',
      });
    });
  }
}
