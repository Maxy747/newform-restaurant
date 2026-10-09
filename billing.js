// Invoice and credit-note rendering, shared by the printable invoice page and the admin console.
import { escapeHTML as e, statusLabel as label } from './oms-policy.js';
import { placeOfSupply } from './supabase/functions/_shared/billing.js';
export { GSTIN, normalizeBillingSettings, placeOfSupply } from './supabase/functions/_shared/billing.js';

export const RECEIPTS_KEY = 'newform_order_receipts_v1'; // same device storage the customer site writes guest keys to
const PAYMENT_NAMES = { cod: 'Cash on delivery', cash: 'Cash at counter', whatsapp: 'Arranged with restaurant', razorpay: 'Online (Razorpay)' };

export const rupees2 = value => '₹' + (Number(value) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const billDate = value => new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
export const docTitle = seller => seller?.gstin ? 'Tax invoice' : 'Bill';

export function guestToken(orderId, storage = globalThis.localStorage) {
  try { return (JSON.parse(storage.getItem(RECEIPTS_KEY)) || []).find(r => r.id === orderId)?.token; } catch { return undefined; }
}

function sellerBlock(seller) {
  const ids = [seller.phone && `Phone ${seller.phone}`, seller.gstin && `GSTIN ${seller.gstin}`, seller.fssai && `FSSAI ${seller.fssai}`].filter(Boolean);
  return `<div class="inv-seller"><h1>${e(seller.legal_name)}</h1><p class="inv-pre">${e(seller.address)}</p>${ids.length ? `<p>${ids.map(e).join(' · ')}</p>` : ''}</div>`;
}

function buyerBlock(buyer, seller) {
  const where = buyer.order_type === 'dine_in' ? `Dine in${buyer.table ? ` · Table ${buyer.table}` : ''}` : label(buyer.order_type);
  const supply = placeOfSupply(seller.gstin);
  return `<div class="inv-buyer"><h2>Billed to</h2>
    <p><strong>${e(buyer.name || 'Walk-in customer')}</strong>${buyer.phone ? `<br>${e(buyer.phone)}` : ''}${buyer.address ? `<br><span class="inv-pre">${e(buyer.address)}</span>` : ''}</p>
    <p>${e(where)}${supply ? `<br>Place of supply: ${e(supply)}` : ''}</p></div>`;
}

const meta = rows => `<dl class="inv-meta">${rows.filter(([, value]) => value).map(([key, value]) => `<dt>${e(key)}</dt><dd>${e(value)}</dd>`).join('')}</dl>`;
const totals = rows => `<dl class="inv-totals">${rows.filter(row => row && (row[2] || Number(row[1]))).map(([key, value, strong]) => `<dt${strong ? ' class="inv-grand"' : ''}>${e(key)}</dt><dd${strong ? ' class="inv-grand"' : ''}>${e(rupees2(value))}</dd>`).join('')}</dl>`;

export function renderInvoice(invoice) {
  const { seller, buyer } = invoice;
  const lines = invoice.lines.map((item, index) => `<tr><td>${index + 1}</td><td>${e(item.name)}${item.portion && item.portion !== 'single' ? ` <small>(${e(item.portion)})</small>` : ''}</td><td class="inv-num">${e(item.quantity)}</td><td class="inv-num">${e(rupees2(item.price))}</td><td class="inv-num">${e(rupees2(item.quantity * item.price))}</td></tr>`).join('');
  return `<article class="inv-doc">
    <header class="inv-head">${sellerBlock(seller)}
      <div class="inv-title"><strong>${e(docTitle(seller))}</strong>${meta([['Invoice no.', invoice.invoice_no], ['Date', billDate(invoice.issued_at)], ['Order', '#' + invoice.order_id.slice(0, 8).toUpperCase()], ['Payment', PAYMENT_NAMES[invoice.payment_method] || label(invoice.payment_method)]])}</div>
    </header>
    ${buyerBlock(buyer, seller)}
    <table class="inv-lines"><thead><tr><th>#</th><th>Item${seller.sac ? ` <small>· SAC ${e(seller.sac)}</small>` : ''}</th><th class="inv-num">Qty</th><th class="inv-num">Rate</th><th class="inv-num">Amount</th></tr></thead><tbody>${lines}</tbody></table>
    ${totals([['Taxable value', invoice.taxable, true], ['CGST @ 2.5%', invoice.cgst], ['SGST @ 2.5%', invoice.sgst], ['Delivery charges', invoice.delivery_fee], ['Round off', invoice.round_off], ['Total', invoice.total, true]])}
    <footer class="inv-foot">${seller.footer ? `<p>${e(seller.footer)}</p>` : ''}<p>This is a computer-generated ${e(docTitle(seller).toLowerCase())} and does not need a signature.</p></footer>
  </article>`;
}

export function renderCreditNote(note, invoice) {
  const { seller, buyer } = invoice;
  return `<article class="inv-doc">
    <header class="inv-head">${sellerBlock(seller)}
      <div class="inv-title"><strong>Credit note</strong>${meta([['Credit note no.', note.note_no], ['Date', billDate(note.issued_at)], ['Against invoice', invoice.invoice_no], ['Invoice date', billDate(invoice.issued_at)]])}</div>
    </header>
    ${buyerBlock(buyer, seller)}
    <p class="inv-reason"><strong>Reason:</strong> ${e(note.reason)}</p>
    ${totals([['Taxable value', note.taxable, true], ['CGST @ 2.5%', note.cgst], ['SGST @ 2.5%', note.sgst], ['Other (delivery, round off)', note.other], ['Total credited', note.total, true]])}
    <footer class="inv-foot"><p>This is a computer-generated credit note and does not need a signature.</p></footer>
  </article>`;
}

// CSV for the accountant. Cells that a spreadsheet would run as a formula are prefixed with an apostrophe.
export function invoicesCSV(invoices) {
  const cell = value => {
    let text = value == null ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = "'" + text;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const money = value => (Number(value) || 0).toFixed(2);
  const header = ['Invoice no', 'Date (IST)', 'Customer', 'Phone', 'Order type', 'Payment', 'Taxable value', 'CGST', 'SGST', 'Delivery', 'Round off', 'Total', 'Credited'];
  const rows = invoices.map(i => [i.invoice_no, billDate(i.issued_at), i.buyer?.name, i.buyer?.phone, label(i.buyer?.order_type), PAYMENT_NAMES[i.payment_method] || i.payment_method,
    money(i.taxable), money(i.cgst), money(i.sgst), money(i.delivery_fee), money(i.round_off), money(i.total), money(creditedTotal(i))]);
  return [header, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

// Same rule as public.oms_financial_year: April–March, e.g. 2026-10-09 -> '26-27'.
export function financialYear(today) {
  const [y, m] = today.split('-').map(Number), first = m >= 4 ? y : y - 1;
  return `${String(first % 100).padStart(2, '0')}-${String((first + 1) % 100).padStart(2, '0')}`;
}

// Preset date ranges (India calendar days, inclusive) for the Billing screen. `today` is YYYY-MM-DD.
export function billingRange(preset, today) {
  const [y, m] = today.split('-').map(Number);
  const iso = (year, month, day) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (preset === 'last') {
    const year = m === 1 ? y - 1 : y, month = m === 1 ? 12 : m - 1;
    return { from: iso(year, month, 1), to: iso(year, month, new Date(Date.UTC(year, month, 0)).getUTCDate()) };
  }
  if (preset === 'fy') return { from: iso(m >= 4 ? y : y - 1, 4, 1), to: today };
  return { from: iso(y, m, 1), to: today };
}

export const creditedTotal =invoice => (invoice.credit_notes || []).reduce((sum, note) => sum + Number(note.total || 0), 0);

// An invoice whose order was refunded but has not been fully credited needs an admin's attention.
export function needsCreditNote(invoice) {
  return invoice.order?.payment_status === 'refunded' &&creditedTotal(invoice) < Number(invoice.total) - 0.005;
}
