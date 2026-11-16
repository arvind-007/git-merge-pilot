/** Calendar-month windows in an IANA timezone, without external date libraries. */

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function partsIn(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const map: Record<string, number> = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== 'literal') map[p.type] = Number(p.value);
  return {
    year: map.year!,
    month: map.month!,
    day: map.day!,
    hour: map.hour === 24 ? 0 : map.hour!,
    minute: map.minute!,
    second: map.second!,
  };
}

/** Offset (ms) of `timeZone` from UTC at instant `date` (local = utc + offset). */
export function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const p = partsIn(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** UTC instant of local midnight on `year-month-01` in `timeZone`. */
function localMonthStart(year: number, month1: number, timeZone: string): Date {
  const guess = Date.UTC(year, month1 - 1, 1);
  let instant = guess - timeZoneOffsetMs(new Date(guess), timeZone);
  // Re-evaluate the offset at the candidate instant (handles DST transitions).
  instant = guess - timeZoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/** [start, end) of the calendar month containing `now` in `timeZone` (falls back to UTC for invalid zones). */
export function monthWindow(
  now: Date,
  timeZone: string | null | undefined,
): { start: Date; end: Date; timeZone: string } {
  const tz = timeZone && isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const p = partsIn(now, tz);
  const start = localMonthStart(p.year, p.month, tz);
  const nextYear = p.month === 12 ? p.year + 1 : p.year;
  const nextMonth = p.month === 12 ? 1 : p.month + 1;
  const end = localMonthStart(nextYear, nextMonth, tz);
  return { start, end, timeZone: tz };
}
