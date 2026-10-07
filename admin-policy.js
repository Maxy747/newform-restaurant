// Pure helpers for the admin console; kept DOM-free so they can be unit tested.

export const BOARD_COLUMNS = [
  { key: 'new', title: 'New', statuses: ['new', 'awaiting_payment'] },
  { key: 'preparing', title: 'Preparing', statuses: ['confirmed', 'preparing'] },
  { key: 'ready', title: 'Ready', statuses: ['ready'] },
  { key: 'out', title: 'Out for delivery', statuses: ['out_for_delivery'] },
];
export const FINISHED_STATUSES = ['completed', 'cancelled'];

// Oldest first inside each column so the longest-waiting order is on top.
export function groupOrders(orders) {
  const columns = Object.fromEntries(BOARD_COLUMNS.map(column => [column.key, []]));
  const finished = [];
  for (const order of orders) {
    const column = BOARD_COLUMNS.find(entry => entry.statuses.includes(order.order_status));
    if (column) columns[column.key].push(order);
    else finished.push(order);
  }
  const byAge = (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at);
  Object.values(columns).forEach(list => list.sort(byAge));
  finished.sort((a, b) => Date.parse(b.updated_at || b.created_at) - Date.parse(a.updated_at || a.created_at));
  return { columns, finished };
}

// IDs of incoming orders not seen before. The first load only primes `seen`, so a refresh never replays alerts.
export function findNewOrders(seen, orders, primed) {
  const fresh = [];
  for (const order of orders) {
    if (seen.has(order.id)) continue;
    seen.add(order.id);
    if (primed && order.order_status === 'new') fresh.push(order);
  }
  return fresh;
}

export function minutesSince(timestamp, now = Date.now()) {
  return Math.max(0, Math.floor((now - Date.parse(timestamp)) / 60000));
}

export function ageLabel(timestamp, now = Date.now()) {
  const minutes = minutesSince(timestamp, now);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} d`;
}

const price = value => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 100000 ? Math.round(number * 100) / 100 : null;
};

// Validates the dish editor and returns a menu_items row (without id) or throws a readable error.
export function buildMenuRow(fields) {
  const name = String(fields.name || '').trim();
  if (!name || name.length > 100) throw new Error('Enter a dish name (up to 100 characters).');
  if (!fields.category) throw new Error('Choose a category.');
  if (!['veg', 'non-veg'].includes(fields.diet)) throw new Error('Choose veg or non-veg.');
  const row = {
    name,
    category: fields.category,
    diet: fields.diet,
    tag: String(fields.tag || '').trim().slice(0, 30) || null,
    description: String(fields.description || '').trim().slice(0, 500) || null,
    portionType: fields.portionType === 'multi' ? 'multi' : 'single',
    available: Boolean(fields.available),
  };
  if (row.portionType === 'single') {
    row.price = price(fields.price);
    if (row.price == null) throw new Error('Enter a price above ₹0.');
    row.pricesJSON = null;
  } else {
    const prices = { quarter: price(fields.quarter), half: price(fields.half), full: price(fields.full) };
    if (Object.values(prices).some(value => value == null)) throw new Error('Enter quarter, half and full prices above ₹0.');
    row.pricesJSON = prices;
    row.price = null;
  }
  return row;
}

export function menuPrices(item) {
  let prices = item.prices || item.pricesJSON;
  if (typeof prices === 'string') { try { prices = JSON.parse(prices); } catch { prices = null; } }
  return item.portionType === 'multi' && prices ? prices : null;
}
