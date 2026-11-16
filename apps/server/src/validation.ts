import { z } from 'zod';

export function isValidTimezone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const TimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidTimezone, 'Unknown time zone');

export const EmailSchema = z
  .string()
  .trim()
  .max(254)
  .email('Enter a valid email address')
  .transform((v) => v.toLowerCase());

export const NameSchema = z.string().trim().min(1, 'Name is required').max(120);

export const IdParamsSchema = z.object({ id: z.string().uuid('Invalid id') });

export const ClockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');

export const HttpUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'Must be an http(s) URL without credentials');

/** Accepts "true"/"1"/"false"/"0" query values. */
export const QueryBool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', ''])])
  .optional()
  .transform((v) =>
    v === undefined || v === '' ? undefined : v === true || v === 'true' || v === '1',
  );

export const LimitSchema = (def: number, max: number) =>
  z.coerce.number().int().min(1).max(max).optional().default(def);
