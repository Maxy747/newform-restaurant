// Admin → Counter: ring up walk-in takeaway / dine-in sales paid by cash or UPI, then print the bill.
import { escapeHTML as e, money, orderNumber } from './oms-policy.js';
import { isOfflineError, OfflineError } from './oms-client.js';
import { PORTIONS, unitPrice, addToTicket, setQuantity, ticketTotals, ticketItems, changeDue } from './counter-policy.js';
import { menuPrices } from './admin-policy.js';
import { provisionalNumber, offlineReceiptHTML } from './counter-policy.js';

const PORTION_SHORT = { quarter: 'Qtr', half: 'Half', full: 'Full' };
// Tile buttons are narrow, so drop the ".00" on whole-rupee prices.
const tilePrice = value => `₹${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const MENU_KEY = 'menu:counter';
const OFF_KEY = 'newform_offline_bills_v1';
const istDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

// offline: { store, outbox, userId(), isOffline(), setOffline(bool), flush() } lets a sale go
// through with no internet: it is saved in the outbox and sent (and invoiced) once back online.
export function createCounter({ supabase, api, toast, run, ask, billingEnabled, offline }) {
  const $ = id => document.getElementById(id);
  let lastOffline = null, menu = [], categories = [], category = '', lines = [], type = 'takeaway', method = 'cash', requestId = crypto.randomUUID(), charging = false, ticketInView = false;

  // The live menu, saved on the device for offline sales; offline, the last saved copy.
  async function loadMenu() {
    const [items, cats] = await Promise.all([
      supabase.from('menu_items').select('*').order('name'),
      supabase.from('menu_categories').select('*').order('sort_order').order('id'),
    ]);
    const error = items.error || cats.error;
    if (!error) {
      const saved = { items: items.data, categories: cats.data || [], at: new Date().toISOString() };
      offline?.store.set(MENU_KEY, saved).catch(() => {});
      return saved;
    }
    if (!isOfflineError(error)) throw new Error(error.message);
    offline?.setOffline(true);
    const saved = await offline?.store.get(MENU_KEY).catch(() => null);
    if (!saved) throw new OfflineError('The menu is not saved on this device yet. Open Counter once while online.');
    return saved;
  }

  async function open() {
    const saved = await loadMenu();
    menu = saved.items.filter(item => item.available !== false);
    categories = saved.categories.filter(cat => !cat.archived && menu.some(item => item.category === cat.id));
    // Drop lines whose dish went out of stock since they were added; the server would refuse them anyway.
    const removed = lines.filter(line => !menu.some(item => item.id === line.id));
    if (removed.length) { lines = lines.filter(line => !removed.includes(line)); toast(`${removed.map(line => line.name).join(', ')} removed: out of stock`, 'error'); }
    renderMenu(); renderTicket();
    $('counterNotice').hidden = billingEnabled() || offline?.isOffline() === true;
  }

  function renderMenu() {
    $('counterCats').innerHTML = [['', 'All'], ...categories.map(cat => [cat.id, cat.name])]
      .map(([id, name]) => `<button type="button" role="tab" data-cat="${e(id)}" aria-selected="${id === category}">${e(name)}</button>`).join('');
    const term = $('counterSearch').value.trim().toLowerCase();
    const shown = menu.filter(item => (!category || item.category === category) && (!term || item.name.toLowerCase().includes(term)));
    $('counterGrid').innerHTML = shown.map(item => {
      const multi = menuPrices(item);
      const prices = multi
        ? `<div class="adm-portions">${PORTIONS.filter(p => unitPrice(item, p)).map(p => `<button type="button" class="adm-btn" data-add="${e(item.id)}" data-portion="${p}" aria-label="Add ${e(item.name)}, ${p}, ${money(unitPrice(item, p))}"><small>${PORTION_SHORT[p]}</small><b>${tilePrice(unitPrice(item, p))}</b></button>`).join('')}</div>`
        : `<b class="adm-dish-price">${money(unitPrice(item))}</b>`;
      const tag = multi ? 'div' : 'button';
      return `<${tag} ${multi ? '' : `type="button" data-add="${e(item.id)}" data-portion="single" aria-label="Add ${e(item.name)}, ${money(unitPrice(item))}" `}class="adm-dish-tile"><span class="adm-diet adm-diet-${e(item.diet)}" aria-hidden="true"></span><strong>${e(item.name)}</strong>${prices}</${tag}>`;
    }).join('') || '<p class="adm-empty">No dishes match.</p>';
  }

  function renderTicket() {
    const totals = ticketTotals(lines);
    $('ticketLines').innerHTML = lines.map(line => `<li>
      <span><strong>${e(line.name)}</strong>${line.portion !== 'single' ? ` <small>(${e(line.portion)})</small>` : ''}<small>${money(line.price)} each</small></span>
      <span class="adm-qty"><button type="button" class="adm-icon-btn" data-qty="${e(line.key)}" data-step="-1" aria-label="One less ${e(line.name)}"><i class="fa-solid fa-minus"></i></button><b>${line.quantity}</b><button type="button" class="adm-icon-btn" data-qty="${e(line.key)}" data-step="1" aria-label="One more ${e(line.name)}"><i class="fa-solid fa-plus"></i></button></span>
      <strong class="adm-line-total">${money(line.price * line.quantity)}</strong></li>`).join('') || '<li class="adm-empty">Tap dishes to add them to the bill.</li>';
    $('ticketTotals').innerHTML = `<dt>Subtotal</dt><dd>${money(totals.subtotal)}</dd><dt>GST 5%</dt><dd>${money(totals.tax)}</dd><dt class="adm-total">Total</dt><dd class="adm-total">${money(totals.total)}</dd>`;
    document.querySelectorAll('#ticketType [data-type]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.type === type)));
    document.querySelectorAll('#ticketPay [data-method]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.method === method)));
    $('ticketTableField').hidden = type !== 'dine_in';
    $('cashReceivedField').hidden = method !== 'cash';
    const change = method === 'cash' ? changeDue(totals.total, $('cashReceived').value) : null;
    $('changeDue').textContent = change == null ? '' : change < 0 ? `${money(-change)} still to collect` : `Change to give: ${money(change)}`;
    $('changeDue').classList.toggle('is-short', change != null && change < 0);
    $('chargeBtn').disabled = !lines.length || charging;
    $('chargeBtn').innerHTML = `<i class="fa-solid fa-cash-register"></i> Charge ${money(totals.total)} · ${method === 'upi' ? 'UPI' : 'Cash'}`;
    $('ticketJump').hidden = !lines.length || ticketInView;
    $('ticketJump').innerHTML = `<i class="fa-solid fa-receipt"></i> View bill · ${totals.count} item${totals.count === 1 ? '' : 's'} · ${money(totals.total)}`;
  }

  function reset() {
    lines = []; requestId = crypto.randomUUID();
    ['ticketTable', 'ticketName', 'ticketPhone', 'cashReceived'].forEach(id => { $(id).value = ''; });
    renderTicket();
  }

  async function charge() {
    if (charging || !lines.length) return;
    const totals = ticketTotals(lines), table = $('ticketTable').value.trim();
    if (type === 'dine_in' && !table) { $('ticketTable').focus(); throw new Error('Enter the table number for a dine-in bill'); }
    if (method === 'cash') {
      const change = changeDue(totals.total, $('cashReceived').value);
      if (change != null && change < 0) throw new Error(`Cash received is ${money(-change)} short of the total`);
    }
    const paid = await ask({ title: `${money(totals.total)} received by ${method === 'upi' ? 'UPI' : 'cash'}?`, message: method === 'upi' ? 'Check the payment shows as successful on the UPI app before confirming.' : 'The sale is saved as paid and goes to the kitchen.', choices: [{ label: 'Yes, payment received', value: 'yes', tone: 'primary' }, { label: 'Not yet', value: null }] });
    if (!paid) return;
    charging = true; renderTicket();
    const payload = { requestId, method, items: ticketItems(lines), customer: { order_type: type, table, name: $('ticketName').value.trim(), phone: $('ticketPhone').value.trim() } };
    const soldAt = new Date().toISOString();
    try {
      const { order, invoice } = await api('counter_order', payload);
      showDone(order, invoice);
      reset();
    } catch (error) {
      // No internet: keep the sale on this device. The same requestId means it can never be saved twice.
      if (!offline || !isOfflineError(error)) throw error;
      offline.setOffline(true);
      await saveOffline(payload, soldAt, totals, table);
      reset();
    } finally { charging = false; renderTicket(); }
  }

  function nextProvisional() {
    let counts = {};
    try { counts = JSON.parse(localStorage.getItem(OFF_KEY)) || {}; } catch { counts = {}; }
    const day = istDay(), n = (Number(counts[day]) || 0) + 1;
    try { localStorage.setItem(OFF_KEY, JSON.stringify({ [day]: n })); } catch { /* storage blocked */ }
    return provisionalNumber(n);
  }

  async function saveOffline(payload, soldAt, totals, table) {
    const provisional = nextProvisional();
    const receipt = { provisional, soldAt, method: payload.method, type: payload.customer.order_type, table, name: payload.customer.name,
      cashReceived: Number($('cashReceived').value) || null, lines: lines.map(line => ({ name: line.name, portion: line.portion, quantity: line.quantity, price: line.price })), totals };
    const entry = await offline.outbox.add({ kind: 'counter', userId: offline.userId(), label: `Counter bill ${provisional} · ${money(totals.total)}`, provisional, soldAt, payload, receipt });
    lastOffline = entry;
    $('counterDoneTitle').textContent = `Bill ${provisional} paid · ${money(totals.total)} · saved offline`;
    $('counterDoneMessage').textContent = 'No internet, so this sale is saved on this device. Print the bill and give the kitchen its copy: the kitchen screen gets it when the internet is back, and the GST invoice is issued then.';
    $('counterPrint').hidden = true;
    $('counterPrintOffline').hidden = false;
    $('counterDoneDialog').showModal();
    offline.flush();
  }

  // Provisional bill printed from the device itself (the invoice page needs the server).
  function printOffline(entry) {
    $('offlineReceipt').innerHTML = offlineReceiptHTML(entry.receipt);
    document.body.classList.add('is-printing-receipt');
    const done = () => { document.body.classList.remove('is-printing-receipt'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
    setTimeout(done, 1000);
  }

  function showDone(order, invoice) {
    $('counterDoneTitle').textContent = `Bill ${orderNumber(order)} paid · ${money(order.total)}`;
    $('counterDoneMessage').textContent = invoice
      ? `Invoice ${invoice.invoice_no}. The order is with the kitchen.`
      : 'The order is with the kitchen. No bill was issued because invoicing is off. An admin can turn it on in Settings → Invoices.';
    $('counterPrintOffline').hidden = true;
    $('counterPrint').hidden = !invoice;
    if (invoice) $('counterPrint').href = `invoice.html?order=${encodeURIComponent(order.id)}&paper=receipt&print=1`;
    $('counterDoneDialog').showModal();
  }

  // ---------- events ----------
  $('counterSearch').addEventListener('input', renderMenu);
  $('counterCats').addEventListener('click', event => {
    const button = event.target.closest('[data-cat]');
    if (!button) return;
    category = button.dataset.cat; renderMenu();
  });
  $('counterGrid').addEventListener('click', event => {
    const button = event.target.closest('[data-add]');
    if (!button) return;
    const item = menu.find(row => row.id === button.dataset.add);
    try { lines = addToTicket(lines, item, button.dataset.portion); renderTicket(); } catch (error) { toast(error.message, 'error'); }
  });
  $('ticketLines').addEventListener('click', event => {
    const button = event.target.closest('[data-qty]');
    if (!button) return;
    const line = lines.find(row => row.key === button.dataset.qty);
    lines = setQuantity(lines, line.key, line.quantity + Number(button.dataset.step)); renderTicket();
  });
  $('ticketType').addEventListener('click', event => { const b = event.target.closest('[data-type]'); if (b) { type = b.dataset.type; renderTicket(); } });
  $('ticketPay').addEventListener('click', event => { const b = event.target.closest('[data-method]'); if (b) { method = b.dataset.method; renderTicket(); } });
  $('cashReceived').addEventListener('input', renderTicket);
  $('ticketClear').onclick = run(async () => {
    if (!lines.length) return;
    const sure = await ask({ title: 'Clear this bill?', message: 'All items on the current bill will be removed.', choices: [{ label: 'Clear bill', value: 'yes', tone: 'danger' }, { label: 'Keep it', value: null }] });
    if (sure) reset();
  });
  $('chargeBtn').onclick = run(charge);
  // On phones the jump bar disappears once the bill itself is on screen, so it never covers Charge.
  new IntersectionObserver(([entry]) => { ticketInView = entry.isIntersecting; renderTicket(); }, { threshold: 0.1 }).observe($('counterTicket'));
  $('ticketJump').onclick = () => $('counterTicket').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('counterPrintOffline').onclick = () => { if (lastOffline) printOffline(lastOffline); };
  $('counterNew').onclick = () => { $('counterDoneDialog').close(); $('counterSearch').focus(); };

  // Save the menu in the background at sign-in, so the first offline sale doesn't depend on
  // someone having opened Counter while online.
  const prefetch = () => loadMenu().then(() => true, () => false);

  return { open, prefetch };
}
