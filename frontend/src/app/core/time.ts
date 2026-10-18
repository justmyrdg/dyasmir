/** All times are shown in Asia/Manila (UTC+8, no daylight saving). */
export const MANILA_TZ = 'Asia/Manila';
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

const dateTimeFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: MANILA_TZ,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

export function formatManila(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return dateTimeFmt.format(new Date(value));
}

const timeFmt = new Intl.DateTimeFormat('en-PH', { timeZone: MANILA_TZ, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });

/** "7:31:05 AM" in Manila time. */
export function formatManilaTime(value: string | Date | null | undefined): string {
  return value ? timeFmt.format(new Date(value)) : '—';
}

/** "1d 02:03:04" / "02:03:04" / "03:04" */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  const hms = h > 0 || d > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  return d > 0 ? `${d}d ${hms}` : hms;
}

/** ISO instant -> value for <input type="datetime-local"> in Manila time. */
export function toManilaInput(value: string | Date | null | undefined): string {
  if (!value) return '';
  return new Date(new Date(value).getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 16);
}

/** <input type="datetime-local"> value (Manila wall time) -> ISO string with explicit +08:00 offset. */
export function fromManilaInput(value: string): string {
  return `${value.length === 16 ? `${value}:00` : value}+08:00`;
}
