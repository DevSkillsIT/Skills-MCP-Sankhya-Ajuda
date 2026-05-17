/**
 * PM2 Ecosystem Configuration for Sankhya Ajuda MCP Server
 * Streamable HTTP Transport
 *
 * Paths are resolved relative to this file (__dirname), so the config is
 * portable — clone anywhere and `pm2 start ecosystem.http.config.cjs` works.
 *
 * Log directory:
 *   - default: ./logs/ (sibling of this file, auto-created by PM2)
 *   - override: set MCP_LOG_DIR to an absolute path before `pm2 start`
 *
 * Skills IT Solucoes em Tecnologia
 */

const path = require('node:path');

const HERE = __dirname;
const LOG_DIR = process.env.MCP_LOG_DIR || path.join(HERE, 'logs');

module.exports = {
  apps: [
    {
      name: 'mcp-sankhya-ajuda',
      cwd: HERE,
      script: '/bin/bash',
      args:
        `-c "set -a; source ${path.join(HERE, '.env')}; ` +
        `exec /usr/bin/node ${path.join(HERE, 'dist', 'index.js')}"`,
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
      },
      log_file: path.join(LOG_DIR, 'mcp-sankhya-ajuda-combined.log'),
      out_file: path.join(LOG_DIR, 'mcp-sankhya-ajuda-out.log'),
      error_file: path.join(LOG_DIR, 'mcp-sankhya-ajuda-error.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '500M',
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      kill_timeout: 5000,
    },
  ],
};
