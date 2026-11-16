/**
 * One-time setup token (design §2 Auth): generated on boot while no admin exists, stored only as
 * a sha256 hash in system_state, and printed once so the operator can open the setup wizard.
 */
import { eq, sql } from 'drizzle-orm';
import { generateToken, sha256Hex, timingSafeEqualStr, type Logger } from '@gmp/core';
import { systemState, users, type Database, type DbOrTx } from '@gmp/db';

export async function ensureSystemState(db: DbOrTx) {
  await db.insert(systemState).values({ singleton: true }).onConflictDoNothing();
  const [row] = await db.select().from(systemState).where(eq(systemState.singleton, true)).limit(1);
  return row!;
}

export async function adminExists(db: DbOrTx): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.role, 'admin'));
  return (row?.n ?? 0) > 0;
}

export interface SetupTokenResult {
  /** The plaintext token, only when a new one was generated. */
  token: string | null;
  setupUrl: string | null;
}

/** Writes the banner straight to stdout: pino would (correctly) redact the token. */
export function printSetupBanner(token: string | null, setupUrl: string): void {
  const line = '='.repeat(72);
  const body = token
    ? [
        ' No admin account exists yet. Open this one-time setup link to create',
        ' the first admin (the token is built into the link):',
        '',
        `   ${setupUrl}?token=${encodeURIComponent(token)}`,
        '',
        ` If you open ${setupUrl} directly, enter this setup token:`,
        `   ${token}`,
        '',
        ' The token is valid until the first admin is created. Restarting the',
        ' server before then replaces it with a new token.',
      ]
    : [
        ' No admin account exists yet. Open the setup page and enter the',
        ' setup token you set in GMP_SETUP_TOKEN:',
        '',
        `   ${setupUrl}`,
      ];
  process.stdout.write(
    ['', line, ' git-merge-pilot first-time setup', line, ...body, line, ''].join('\n') + '\n',
  );
}

/**
 * On boot: if no admin exists, generate a fresh setup token, store its hash and print it.
 * If an admin exists, clears any leftover hash. Returns the token (for tests).
 */
export async function ensureSetupToken(
  db: Database,
  opts: {
    publicUrl: string;
    logger?: Logger;
    /** Operator-chosen token (GMP_SETUP_TOKEN). Used instead of a generated one and never printed. */
    presetToken?: string | null;
    print?: (token: string | null, setupUrl: string) => void;
  },
): Promise<SetupTokenResult> {
  await ensureSystemState(db);
  if (await adminExists(db)) {
    await db
      .update(systemState)
      .set({ setupTokenHash: null })
      .where(sql`${systemState.singleton} = true and ${systemState.setupTokenHash} is not null`);
    return { token: null, setupUrl: null };
  }
  const preset = opts.presetToken?.trim() || null;
  if (preset !== null && preset.length < 16) {
    throw new Error('GMP_SETUP_TOKEN must be at least 16 characters long.');
  }
  const token = preset ?? generateToken(24);
  await db
    .update(systemState)
    .set({ setupTokenHash: sha256Hex(token) })
    .where(eq(systemState.singleton, true));
  const setupUrl = `${opts.publicUrl}/setup`;
  (opts.print ?? printSetupBanner)(preset ? null : token, setupUrl);
  opts.logger?.warn(
    { setupUrl },
    preset
      ? 'No admin account exists: open the setup page and enter the token from GMP_SETUP_TOKEN.'
      : 'No admin account exists: a one-time setup link was printed above.',
  );
  return { token, setupUrl };
}

export function setupTokenMatches(hash: string | null, token: string): boolean {
  if (!hash || !token) return false;
  return timingSafeEqualStr(hash, sha256Hex(token.trim()));
}
