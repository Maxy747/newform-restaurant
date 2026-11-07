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

// Bills rung up with no internet get a device number until the server gives them a real one.
export const provisionalNumber = n => `OFF-${n}`;

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const rs = value => `₹${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const TYPE = { takeaway: 'Takeaway', dine_in: 'Dine in' };

// Provisional receipt + kitchen copy, printed from the device while offline. Not a tax invoice:
// the GST invoice is numbered by the server once the sale syncs.
export function offlineReceiptHTML(receipt) {
  const when = new Date(receipt.soldAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const where = `${TYPE[receipt.type] || esc(receipt.type)}${receipt.table ? ' · Table ' + esc(receipt.table) : ''}`;
  const item = line => `${esc(line.name)}${line.portion && line.portion !== 'single' ? ` (${esc(line.portion)})` : ''}`;
  const change = receipt.method === 'cash' && receipt.cashReceived ? Math.round((receipt.cashReceived - receipt.totals.total) * 100) / 100 : null;
  return `<div class="rcpt">
    <h1>NEWFORM</h1>
    <p class="rcpt-c">Provisional bill · not a tax invoice</p>
    <p class="rcpt-row"><b>Bill ${esc(receipt.provisional)}</b><span>${esc(when)}</span></p>
    <p>${where}${receipt.name ? ' · ' + esc(receipt.name) : ''}</p>
    <table>${receipt.lines.map(line => `<tr><td>${line.quantity} × ${item(line)}</td><td>${rs(line.price * line.quantity)}</td></tr>`).join('')}</table>
    <table class="rcpt-tot"><tr><td>Subtotal</td><td>${rs(receipt.totals.subtotal)}</td></tr><tr><td>GST 5%</td><td>${rs(receipt.totals.tax)}</td></tr><tr><th>Total</th><th>${rs(receipt.totals.total)}</th></tr>
    <tr><td>Paid by ${receipt.method === 'upi' ? 'UPI' : 'cash'}</td><td>${receipt.cashReceived && receipt.method === 'cash' ? rs(receipt.cashReceived) : ''}</td></tr>${change > 0 ? `<tr><td>Change</td><td>${rs(change)}</td></tr>` : ''}</table>
    <p class="rcpt-c">GST invoice will be issued when this bill syncs.</p>
  </div>
  <div class="rcpt rcpt-kitchen">
    <h2>KITCHEN · ${esc(receipt.provisional)}</h2>
    <p>${where} · ${esc(when)}</p>
    <ul>${receipt.lines.map(line => `<li><b>${line.quantity}×</b> ${item(line)}</li>`).join('')}</ul>
  </div>`;
}
