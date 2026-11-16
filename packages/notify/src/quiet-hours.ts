import { DateTime, IANAZone } from 'luxon';

export interface QuietHoursWindow {
  /** "HH:MM" local time, inclusive. */
  quietStart: string | null | undefined;
  /** "HH:MM" local time, exclusive. */
  quietEnd: string | null | undefined;
  /** IANA zone; invalid/empty zones fall back to UTC. */
  timezone: string | null | undefined;
}

/** Parses "HH:MM" (or "H:MM", optional ":SS") into minutes after midnight; null if invalid. */
export function parseClockTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Returns a valid IANA zone name, falling back to `fallback` (default UTC). */
export function normalizeTimezone(zone: string | null | undefined, fallback = 'UTC'): string {
  if (zone && IANAZone.isValidZone(zone)) return zone;
  if (fallback !== 'UTC' && IANAZone.isValidZone(fallback)) return fallback;
  return 'UTC';
}

/**
 * When `now` falls inside the quiet window, returns the instant the window ends (the next local
 * occurrence of `quietEnd`, DST-aware); otherwise null. Windows may wrap past midnight
 * (e.g. 22:00–07:00). Equal or missing start/end means no quiet hours.
 */
export function quietHoursEnd(now: Date, window: QuietHoursWindow): Date | null {
  const start = parseClockTime(window.quietStart);
  const end = parseClockTime(window.quietEnd);
  if (start === null || end === null || start === end) return null;

  const zone = normalizeTimezone(window.timezone);
  const local = DateTime.fromJSDate(now, { zone });
  const minutes = local.hour * 60 + local.minute;

  const inside =
    start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  if (!inside) return null;

  const endH = Math.floor(end / 60);
  const endM = end % 60;
  let endAt = local.set({ hour: endH, minute: endM, second: 0, millisecond: 0 });
  if (endAt <= local) endAt = endAt.plus({ days: 1 }).set({ hour: endH, minute: endM });
  // A DST gap can shift a wall-clock time; make sure we never return a time in the past.
  if (endAt.toMillis() <= now.getTime()) return new Date(now.getTime() + 60_000);
  return endAt.toJSDate();
}

/** True when `now` is inside the quiet window. */
export function isWithinQuietHours(now: Date, window: QuietHoursWindow): boolean {
  return quietHoursEnd(now, window) !== null;
}

/** Local calendar date ("yyyy-MM-dd") of `at` in `timezone` (used for digest bookkeeping). */
export function localDate(at: Date, timezone: string | null | undefined): string {
  return DateTime.fromJSDate(at, { zone: normalizeTimezone(timezone) }).toFormat('yyyy-MM-dd');
}

/**
 * True when the rule's local digest hour has passed today and no digest was produced yet today
 * (in the rule's timezone). Helper for the `digest.daily` job (design §11).
 */
export function isDigestDue(
  now: Date,
  rule: {
    digestEnabled: boolean;
    digestHour: number;
    timezone: string | null;
    lastDigestAt: Date | null;
  },
): boolean {
  if (!rule.digestEnabled) return false;
  const zone = normalizeTimezone(rule.timezone);
  const local = DateTime.fromJSDate(now, { zone });
  if (local.hour < rule.digestHour) return false;
  if (!rule.lastDigestAt) return true;
  const last = DateTime.fromJSDate(rule.lastDigestAt, { zone });
  return (
    last.toFormat('yyyy-MM-dd') !== local.toFormat('yyyy-MM-dd') || last.hour < rule.digestHour
  );
}
