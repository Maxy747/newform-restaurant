// Opening hours, shared by the order API and the website so both always agree.
// Times are India time (Asia/Kolkata), minutes after midnight.
export const OPENING_HOURS = { open: 11 * 60, close: 23 * 60 };
export const ORDERING_MODES = ['auto', 'open', 'closed'];

const label = minutes => {
  const hour = Math.floor(minutes / 60), minute = minutes % 60;
  return `${hour % 12 || 12}${minute ? ':' + String(minute).padStart(2, '0') : ''} ${hour < 12 ? 'am' : 'pm'}`;
};
export const OPENS_AT = label(OPENING_HOURS.open);
export const CLOSES_AT = label(OPENING_HOURS.close);

export function indiaMinutes(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  return Number(parts.find(part => part.type === 'hour').value) * 60 + Number(parts.find(part => part.type === 'minute').value);
}

// mode: 'auto' follows OPENING_HOURS; 'open' / 'closed' are the admin's manual override.
export function shopStatus(mode = 'auto', now = new Date()) {
  const minutes = indiaMinutes(now);
  const withinHours = minutes >= OPENING_HOURS.open && minutes < OPENING_HOURS.close;
  const manual = mode === 'open' || mode === 'closed';
  const open = mode === 'open' ? true : mode === 'closed' ? false : withinHours;
  return {
    open,
    manual,
    // Short line for buttons/notices.
    message: open ? `Open now · closes ${CLOSES_AT}` : manual ? 'Closed now · not taking orders' : `Closed now · opens ${OPENS_AT}`,
    button: open ? null : manual ? 'CLOSED' : `CLOSED · OPENS ${OPENS_AT.toUpperCase()}`,
  };
}
