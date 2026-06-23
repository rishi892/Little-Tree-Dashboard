import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env from current working directory if present
dotenv.config();

// Fallback to cashflow-server/.env if running from workspace root
try {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
} catch {
  // Ignore
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required env var: ${name}. Copy server/.env.example to server/.env and fill it in, then restart the server.`,
    );
  }
  return v;
}

// Allowed front-end origins. The primary one (CLIENT_URL) drives OAuth
// redirects. ALLOWED_ORIGINS is a comma-separated list used by the CORS
// middleware so the same backend can serve multiple deployments - e.g.
// cfovaani.com in production, the .htaccess reverse-proxy hop from there,
// AND localhost during dev - without changing code.
const port = Number(process.env.PORT ?? 4747);
const DEFAULT_ALLOWED = [
  `http://localhost:${port}`,
  'http://localhost:4747',
  'http://localhost:4748',
  'http://localhost:5173',  // AR shell (Vite multi-page) in dev
  'https://cfovaani.com',
  'https://www.cfovaani.com',
];
const clientUrl = process.env.CLIENT_URL;
const extraAllowed = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (clientUrl) {
  extraAllowed.push(clientUrl);
}
const ALLOWED_ORIGINS = [...new Set([...DEFAULT_ALLOWED, ...extraAllowed])];

export const config = {
  port: Number(process.env.PORT ?? 4747),
  clientUrl: process.env.CLIENT_URL ?? 'http://localhost:4748',
  allowedOrigins: ALLOWED_ORIGINS,
  qbo: {
    get clientId() { return requireEnv('QBO_CLIENT_ID'); },
    get clientSecret() { return requireEnv('QBO_CLIENT_SECRET'); },
    environment: (process.env.QBO_ENVIRONMENT ?? 'production') as 'production' | 'sandbox',
    redirectUri: process.env.QBO_REDIRECT_URI ?? 'http://localhost:4747/auth/callback',
    credsConfigured: !!process.env.QBO_CLIENT_ID && !!process.env.QBO_CLIENT_SECRET,
  },
};

export const QBO_API_BASE =
  config.qbo.environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
