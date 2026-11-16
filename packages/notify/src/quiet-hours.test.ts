import { describe, expect, it } from 'vitest';
import {
  isDigestDue,
  isWithinQuietHours,
  localDate,
  normalizeTimezone,
  parseClockTime,
  quietHoursEnd,
} from './quiet-hours.ts';

describe('parseClockTime', () => {
  it('parses HH:MM and rejects junk', () => {
    expect(parseClockTime('00:00')).toBe(0);
    expect(parseClockTime('7:30')).toBe(450);
    expect(parseClockTime('23:59:00')).toBe(1439);
    expect(parseClockTime('24:00')).toBeNull();
    expect(parseClockTime('12:60')).toBeNull();
    expect(parseClockTime('noon')).toBeNull();
    expect(parseClockTime(null)).toBeNull();
  });
});

describe('quietHoursEnd', () => {
  const overnight = { quietStart: '22:00', quietEnd: '07:00', timezone: 'Asia/Kolkata' };

  it('returns null outside quiet hours', () => {
    // 12:00 IST
    expect(quietHoursEnd(new Date('2026-11-14T06:30:00Z'), overnight)).toBeNull();
    // 21:59 IST
    expect(quietHoursEnd(new Date('2026-11-14T16:29:00Z'), overnight)).toBeNull();
    // 07:00 IST (end is exclusive)
    expect(quietHoursEnd(new Date('2026-11-14T01:30:00Z'), overnight)).toBeNull();
  });

  it('defers to the next local end time across midnight', () => {
    // 23:30 IST on 14 Nov → 07:00 IST on 15 Nov = 01:30Z
    expect(quietHoursEnd(new Date('2026-11-14T18:00:00Z'), overnight)?.toISOString()).toBe(
      '2026-11-15T01:30:00.000Z',
    );
    // 02:00 IST on 15 Nov → 07:00 IST same day
    expect(quietHoursEnd(new Date('2026-11-14T20:30:00Z'), overnight)?.toISOString()).toBe(
      '2026-11-15T01:30:00.000Z',
    );
    // exactly 22:00 IST (start inclusive)
    expect(isWithinQuietHours(new Date('2026-11-14T16:30:00Z'), overnight)).toBe(true);
  });

  it('handles same-day windows', () => {
    const w = { quietStart: '12:00', quietEnd: '13:30', timezone: 'UTC' };
    expect(quietHoursEnd(new Date('2026-11-14T12:15:00Z'), w)?.toISOString()).toBe(
      '2026-11-14T13:30:00.000Z',
    );
    expect(quietHoursEnd(new Date('2026-11-14T13:30:00Z'), w)).toBeNull();
  });

  it('is DST aware', () => {
    // US DST ends 2026-11-01 02:00 EDT → 01:00 EST. 23:00 EDT on 31 Oct; end 07:00 EST on 1 Nov = 12:00Z.
    const w = { quietStart: '22:00', quietEnd: '07:00', timezone: 'America/New_York' };
    expect(quietHoursEnd(new Date('2026-11-01T03:00:00Z'), w)?.toISOString()).toBe(
      '2026-11-01T12:00:00.000Z',
    );
  });

  it('treats missing, invalid or equal bounds as no quiet hours; invalid zones fall back to UTC', () => {
    const now = new Date('2026-11-14T23:00:00Z');
    expect(quietHoursEnd(now, { quietStart: null, quietEnd: '07:00', timezone: 'UTC' })).toBeNull();
    expect(
      quietHoursEnd(now, { quietStart: '22:00', quietEnd: '22:00', timezone: 'UTC' }),
    ).toBeNull();
    expect(quietHoursEnd(now, { quietStart: 'x', quietEnd: '07:00', timezone: 'UTC' })).toBeNull();
    expect(
      quietHoursEnd(now, {
        quietStart: '22:00',
        quietEnd: '07:00',
        timezone: 'Not/AZone',
      })?.toISOString(),
    ).toBe('2026-11-15T07:00:00.000Z');
    expect(normalizeTimezone('Not/AZone')).toBe('UTC');
    expect(normalizeTimezone('Not/AZone', 'Europe/Paris')).toBe('Europe/Paris');
  });
});

describe('digest scheduling helpers', () => {
  it('computes local dates', () => {
    expect(localDate(new Date('2026-11-14T20:00:00Z'), 'Asia/Tokyo')).toBe('2026-11-15');
  });

  it('isDigestDue honours the local hour and once-per-day', () => {
    const rule = {
      digestEnabled: true,
      digestHour: 9,
      timezone: 'Europe/Berlin',
      lastDigestAt: null,
    };
    expect(isDigestDue(new Date('2026-11-14T07:59:00Z'), rule)).toBe(false); // 08:59 local
    expect(isDigestDue(new Date('2026-11-14T08:00:00Z'), rule)).toBe(true); // 09:00 local
    const sentToday = { ...rule, lastDigestAt: new Date('2026-11-14T08:05:00Z') };
    expect(isDigestDue(new Date('2026-11-14T12:00:00Z'), sentToday)).toBe(false);
    expect(isDigestDue(new Date('2026-11-15T08:01:00Z'), sentToday)).toBe(true);
    expect(isDigestDue(new Date('2026-11-14T12:00:00Z'), { ...rule, digestEnabled: false })).toBe(
      false,
    );
  });
});
