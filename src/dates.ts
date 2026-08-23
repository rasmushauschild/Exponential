import type { ISODate } from './types';

const DAY = 86_400_000;

export function toISO(d: Date): ISODate {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayISO(): ISODate {
  return toISO(new Date());
}

/** Days since epoch for a calendar date (DST-safe via UTC). */
export function dayIndex(iso: ISODate): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
}

export function fromDayIndex(n: number): ISODate {
  const d = new Date(Math.round(n) * DAY);
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: ISODate, n: number): ISODate {
  return fromDayIndex(dayIndex(iso) + n);
}

/** Monday of the week containing the given date. */
export function weekStart(iso: ISODate): ISODate {
  const n = dayIndex(iso);
  const dow = (n + 3) % 7; // epoch (1970-01-01) was a Thursday → Monday = 0
  return fromDayIndex(n - dow);
}

export function isoWeekNumber(iso: ISODate): number {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.ceil(((date.getTime() - yearStart) / DAY + 1) / 7);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function monthShort(iso: ISODate): string {
  return MONTHS[Number(iso.slice(5, 7)) - 1];
}
export function monthLong(iso: ISODate): string {
  return MONTHS_LONG[Number(iso.slice(5, 7)) - 1];
}
export function dayOfMonth(iso: ISODate): number {
  return Number(iso.slice(8, 10));
}
export function weekdayShort(iso: ISODate): string {
  return WEEKDAYS[(dayIndex(iso) + 3) % 7];
}

/** "24 – 30 Aug" or "29 Sep – 5 Oct" */
export function formatRange(start: ISODate, end: ISODate): string {
  if (monthShort(start) === monthShort(end)) {
    return `${dayOfMonth(start)} – ${dayOfMonth(end)} ${monthLong(start)}`;
  }
  return `${dayOfMonth(start)} ${monthShort(start)} – ${dayOfMonth(end)} ${monthShort(end)}`;
}

export function formatShort(iso: ISODate): string {
  return `${dayOfMonth(iso)} ${monthShort(iso)}`;
}
