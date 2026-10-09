// Counter ticket rules. The server re-prices every sale; these keep the on-screen total in step with it.
import { menuPrices } from './admin-policy.js';

export const PORTIONS = ['quarter', 'half', 'full'];
export const MAX_LINES = 50; // same limits as checkout: 1–50 lines, 1–99 of each
export const MAX_QUANTITY = 99;

export function unitPrice(item, portion = 'single') {
  const prices = menuPrices(item);
  const value = prices ? (PORTIONS.includes(portion) ? prices[portion] : null) : portion === 'single' ? item.price : null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export const lineKey = (id, portion) => `${id}:${portion}`;

export function addToTicket(lines, item, portion = 'single') {
  const price = unitPrice(item, portion);
  if (!price) throw new Error(`${item.name} has no price for that portion`);
  const key = lineKey(item.id, portion);
  if (lines.some(line => line.key === key)) return lines.map(line => line.key === key ? { ...line, quantity: Math.min(MAX_QUANTITY, line.quantity + 1) } : line);
  if (lines.length >= MAX_LINES) throw new Error(`A bill can have up to ${MAX_LINES} different items`);
  return [...lines, { key, id: item.id, name: item.name, portion, price, quantity: 1 }];
}

export function setQuantity(lines, key, quantity) {
  const next = Math.min(MAX_QUANTITY, Math.floor(Number(quantity) || 0));
  return next <= 0 ? lines.filter(line => line.key !== key) : lines.map(line => line.key === key ? { ...line, quantity: next } : line);
}

// GST is 5% rounded to the rupee, exactly as oms_create_order_base computes it.
export function ticketTotals(lines) {
  const subtotal = Math.round(lines.reduce((sum, line) => sum + line.price * line.quantity, 0) * 100) / 100;
  const tax = Math.round(subtotal * 0.05);
  return { subtotal, tax, total: subtotal + tax, count: lines.reduce((sum, line) => sum + line.quantity, 0) };
}

export const ticketItems = lines => lines.map(line => ({ id: line.id, portion: line.portion, quantity: line.quantity }));

export function changeDue(total, received) {
  const cash = Number(received);
  if (!Number.isFinite(cash) || cash <= 0) return null;
  return Math.round((cash - total) * 100) / 100;
}
