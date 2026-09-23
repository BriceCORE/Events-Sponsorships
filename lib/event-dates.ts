// Event dates are calendar dates, not timestamps. UTC arithmetic keeps them stable across DST.
const DAY = 86_400_000;
export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T12:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function addDays(value: string, days: number): string {
  if (!validDate(value)) throw new Error('Choose a valid calendar date.');
  return new Date(new Date(value + 'T12:00:00Z').getTime() + days * DAY).toISOString().slice(0, 10);
}
export function formatDate(value: string, options: Intl.DateTimeFormatOptions = {month: 'short', day: 'numeric', year: 'numeric'}): string {
  return validDate(value) ? new Intl.DateTimeFormat('en-US', {...options, timeZone: 'UTC'}).format(new Date(value + 'T12:00:00Z')) : 'Date not confirmed';
}
export function dateRange(start: string, end: string): string {
  return !validDate(start) ? 'Date not confirmed' : !end || end === start ? formatDate(start) : `${formatDate(start)} – ${formatDate(end)}`;
}
export function overlapsDates(event: {startDate: string; endDate: string}, from: string, to: string): boolean {
  if (!validDate(event.startDate)) return !from && !to;
  const end = validDate(event.endDate) ? event.endDate : event.startDate;
  return (!from || end >= from) && (!to || event.startDate <= to);
}
export function isCritical(event: {startDate: string; endDate: string; decision: string}, today = localToday()): boolean {
  return event.decision !== 'decline' && validDate(event.startDate) && overlapsDates(event, today, addDays(today, 27));
}
export function monthDays(month: string): string[] {
  const first = month + '-01';
  if (!validDate(first)) return [];
  const offset = new Date(first + 'T12:00:00Z').getUTCDay();
  const gridStart = addDays(first, -offset);
  return Array.from({length: 42}, (_, index) => addDays(gridStart, index));
}
export function moveMonth(month: string, delta: number): string {
  const date = new Date(month + '-01T12:00:00Z');
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 7);
}
