/**
 * Login verification against the Supabase `app_users` table. Passwords are
 * salted-scrypt hashed (never stored or returned in plaintext), and the check
 * runs server-side - so credentials no longer ship in the browser bundle the
 * way the old hard-coded splash list did. Every attempt is logged to
 * `login_events`.
 */

import crypto from 'node:crypto';
import { dbSelect, dbInsert, dbEnabled } from './db.js';

type UserRow = {
  email: string; password_hash: string; name: string; title: string; photo: string;
  ar_role: string; cashflow_access: boolean; rep: string; active: boolean;
};

export type LoginUser = {
  email: string; name: string; title: string; photo: string;
  role: string; rep: string; cashflowAccess: boolean;
};
export type LoginResult = { ok: boolean; error?: string; user?: LoginUser };

/** Verify a password against a stored `scrypt$salt$hash` value. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = (stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  try {
    const calc = crypto.scryptSync(password, salt, 64);
    const want = Buffer.from(hash, 'hex');
    return calc.length === want.length && crypto.timingSafeEqual(calc, want);
  } catch {
    return false;
  }
}

/** Produce a `scrypt$salt$hash` value (used by the seed / admin tooling). */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

export async function login(email: string, password: string, dashboard: 'ar' | 'cashflow'): Promise<LoginResult> {
  const e = (email || '').trim().toLowerCase();
  if (!e || !password) return { ok: false, error: 'Please enter both username and password.' };
  if (!dbEnabled) return { ok: false, error: 'Login is not configured on the server.' };

  const rows = await dbSelect<UserRow>('app_users', `email=eq.${encodeURIComponent(e)}&active=eq.true&limit=1`);
  const u = rows[0];
  const success = Boolean(u && verifyPassword(password, u.password_hash));
  void dbInsert('login_events', { email: e, dashboard, success });

  if (!success) {
    if (dashboard === 'cashflow' && u && !u.cashflow_access) {
      return { ok: false, error: 'This account is for the AR Dashboard only. Click Back and choose AR Dashboard to sign in.' };
    }
    return { ok: false, error: 'Invalid credentials. Please try again.' };
  }
  if (dashboard === 'cashflow' && !u.cashflow_access) {
    return { ok: false, error: 'This account is for the AR Dashboard only. Click Back and choose AR Dashboard to sign in.' };
  }
  if (dashboard === 'ar' && (!u.ar_role || u.ar_role === 'none')) {
    return { ok: false, error: 'This account has no AR Dashboard access.' };
  }
  return {
    ok: true,
    user: { email: u.email, name: u.name, title: u.title, photo: u.photo, role: u.ar_role, rep: u.rep, cashflowAccess: u.cashflow_access },
  };
}
