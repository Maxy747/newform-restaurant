// Admin → Counter: ring up walk-in takeaway / dine-in sales paid by cash or UPI, then print the bill.
import { escapeHTML as e, money, orderNumber } from './oms-policy.js';
import { PORTIONS, unitPrice, addToTicket, setQuantity, ticketTotals, ticketItems, changeDue } from './counter-policy.js';
import { menuPrices } from './admin-policy.js';

const PORTION_SHORT = { quarter: 'Qtr', half: 'Half', full: 'Full' };

export function createCounter({ supabase, api, toast, run, ask, billingEnabled }) {
  const $ = id => document.getElementById(id);
  let menu = [], categories = [], category = '', lines = [], type = 'takeaway', method = 'cash', requestId = crypto.randomUUID(), charging = false, ticketInView = false;

  async function open() {
    const [items, cats] = await Promise.all([
      supabase.from('menu_items').select('*').order('name'),
      supabase.from('menu_categories').select('*').order('sort_order').order('id'),
    ]);
    if (items.error) throw new Error(items.error.message);
    menu = items.data.filter(item => item.available !== false);
    categories = (cats.data || []).filter(cat => !cat.archived && menu.some(item => item.category === cat.id));
    // Drop lines whose dish went out of stock since they were added; the server would refuse them anyway.
    const removed = lines.filter(line => !menu.some(item => item.id === line.id));
    if (removed.length) { lines = lines.filter(line => !removed.includes(line)); toast(`${removed.map(line => line.name).join(', ')} removed: out of stock`, 'error'); }
    renderMenu(); renderTicket();
    $('counterNotice').hidden = billingEnabled();
  }

  function renderMenu() {
    $('counterCats').innerHTML = [['', 'All'], ...categories.map(cat => [cat.id, cat.name])]
      .map(([id, name]) => `<button type="button" role="tab" data-cat="${e(id)}" aria-selected="${id === category}">${e(name)}</button>`).join('');
    const term = $('counterSearch').value.trim().toLowerCase();
    const shown = menu.filter(item => (!category || item.category === category) && (!term || item.name.toLowerCase().includes(term)));
    $('counterGrid').innerHTML = shown.map(item => {
      const multi = menuPrices(item);
      const prices = multi
        ? `<div class="adm-portions">${PORTIONS.filter(p => unitPrice(item, p)).map(p => `<button type="button" class="adm-btn" data-add="${e(item.id)}" data-portion="${p}" aria-label="Add ${e(item.name)}, ${p}, ${money(unitPrice(item, p))}">${PORTION_SHORT[p]} <b>${money(unitPrice(item, p))}</b></button>`).join('')}</div>`
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
    try {
      const { order, invoice } = await api('counter_order', { requestId, method, items: ticketItems(lines), customer: { order_type: type, table, name: $('ticketName').value.trim(), phone: $('ticketPhone').value.trim() } });
      showDone(order, invoice);
      reset();
    } finally { charging = false; renderTicket(); }
  }

  function showDone(order, invoice) {
    $('counterDoneTitle').textContent = `Bill ${orderNumber(order)} paid · ${money(order.total)}`;
    $('counterDoneMessage').textContent = invoice
      ? `Invoice ${invoice.invoice_no}. The order is with the kitchen.`
      : 'The order is with the kitchen. No bill was issued because invoicing is off. An admin can turn it on in Settings → Invoices.';
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
  $('counterNew').onclick = () => { $('counterDoneDialog').close(); $('counterSearch').focus(); };

  return { open };
}
