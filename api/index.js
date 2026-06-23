/**
 * Vercel serverless entry. Runs the whole Cashflow LT Express app as one
 * function. vercel.json rewrites every /api/* and /auth/* request here; the
 * Express app (imported from the compiled backend) routes them as usual.
 *
 * The backend reads its persistence from Supabase (SUPABASE_URL +
 * SUPABASE_SERVICE_KEY) and its secrets from Vercel env vars, since the
 * serverless filesystem is read-only and resets between invocations.
 */
import app from '../cashflow-server/dist/index.js';

export default app;
