// Admin → Counter → Close day: compare what the drawer should hold with what staff counted.
import { escapeHTML as e, money } from './oms-policy.js';
import { DENOMINATIONS, cleanDenominations, denominationTotal, expectedDrawer, drawerStatus } from './cash-policy.js';

export function createCashCount({ api, toast, run, ask, todayIST }) {
  const $ = id => document.getElementById(id);
  let view = 'bill', summary = null, loadVersion = 0;

  $('cashDenoms').innerHTML = DENOMINATIONS.map(value => `<label class="adm-denom">
    <span>₹${value}</span><span aria-hidden="true">×</span>
    <input type="number" min="0" step="1" inputmode="numeric" data-denom="${value}" aria-label="Number of ₹${value} notes and coins">
    <b data-denom-total="${value}">₹0</b></label>`).join('');

  const counts = () => Object.fromEntries([...document.querySelectorAll('[data-denom]')].map(input => [input.dataset.denom, input.value === '' ? 0 : Number(input.value)]));

  function setView(next) {
    view = next;
    $('section-counter').dataset.view = view;
    $('cashView').hidden = view !== 'cash';
    document.querySelectorAll('#counterView [data-view]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.view === view)));
    if (view === 'cash') open().catch(error => toast(error.message, 'error'));
  }

  async function open() {
    if (view !== 'cash') return;
    const today = todayIST();
    $('cashDay').max = today;
    $('cashDay').min = new Date(Date.parse(today) - 7 * 86400000).toISOString().slice(0, 10);
    if (!$('cashDay').value) $('cashDay').value = today;
    const version = ++loadVersion;
    const result = await api('cash_day', { day: $('cashDay').value });
    if (version !== loadVersion) return;
    summary = result.summary;
    if ($('cashFloat').value === '' && result.lastFloat != null) $('cashFloat').value = Number(result.lastFloat);
    renderHistory(result.counts);
    render();
  }

  function render() {
    if (!summary) return;
    const s = summary, n = key => Number(s[key] || 0), times = key => `${n(key)} ${n(key) === 1 ? 'payment' : 'payments'}`;
    const expected = expectedDrawer($('cashFloat').value, s);
    $('cashExpected').innerHTML = [
      ['Opening float', Number($('cashFloat').value) || 0],
      [`Counter cash sales · ${times('counter_cash_count')}`, n('counter_cash')],
      [`Pay-at-counter orders · ${times('staff_cash_count')}`, n('staff_cash')],
      [`Collected by drivers · ${times('driver_cash_count')}`, n('driver_cash')],
      [`Cash refunds · ${n('cash_refund_count')} cancelled`, -n('cash_refunds')],
    ].map(([label, value]) => `<dt>${e(label)}</dt><dd>${value < 0 ? '−' : ''}${money(Math.abs(value))}</dd>`).join('')
      + `<dt class="adm-total">Expected in drawer</dt><dd class="adm-total">${money(expected)}</dd>`;
    $('cashUpi').textContent = n('upi_count')
      ? `UPI received ${money(n('upi'))} from ${n('upi_count')} counter ${n('upi_count') === 1 ? 'sale' : 'sales'}${n('upi_refunds') ? `, ${money(n('upi_refunds'))} refunded` : ''}. Check it against the UPI app; it isn't in the drawer.`
      : 'No UPI payments at the counter this day.';
    const pieces = counts();
    document.querySelectorAll('[data-denom-total]').forEach(cell => { cell.textContent = money(Number(cell.dataset.denomTotal) * (Number(pieces[cell.dataset.denomTotal]) || 0)); });
    const counted = denominationTotal(pieces), status = drawerStatus(counted, expected);
    $('cashCounted').innerHTML = `<dt class="adm-total">Counted</dt><dd class="adm-total">${money(counted)}</dd>`;
    $('cashDiff').className = `adm-cash-diff is-${status.state}`;
    $('cashDiff').textContent = !counted ? 'Enter how many of each note and coin are in the drawer.'
      : status.state === 'match' ? 'Drawer matches.' : status.state === 'over' ? `Over by ${money(status.amount)}` : `Short by ${money(status.amount)}`;
  }

  function renderHistory(rows) {
    $('cashHistory').innerHTML = rows.map(row => {
      const status = drawerStatus(row.counted, row.expected);
      const at = new Date(row.counted_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
      return `<div class="adm-cash-row"><span><strong>${e(at)}</strong> · ${e(row.counted_by_name)}${row.note ? `<small>${e(row.note)}</small>` : ''}</span>
        <span>${money(row.counted)} <small>of ${money(row.expected)}</small></span>
        <span class="adm-badge adm-cash-${status.state}">${status.state === 'match' ? 'Matched' : `${status.state === 'over' ? 'Over' : 'Short'} ${money(status.amount)}`}</span></div>`;
    }).join('') || '<p class="adm-empty">No count saved for this day yet.</p>';
  }

  async function save() {
    if (!summary) return;
    const pieces = cleanDenominations(counts()), counted = denominationTotal(pieces);
    const float = $('cashFloat').value === '' ? 0 : Number($('cashFloat').value);
    if (!(float >= 0)) throw new Error('Enter the opening float in rupees');
    if (!counted && !Object.keys(pieces).length) {
      const empty = await ask({ title: 'Save an empty drawer?', message: 'No notes or coins were entered.', choices: [{ label: 'Save ₹0 count', value: 'yes', tone: 'danger' }, { label: 'Go back', value: null }] });
      if (!empty) return;
    }
    const status = drawerStatus(counted, expectedDrawer(float, summary));
    if (status.state !== 'match') {
      const sure = await ask({ title: `Save with drawer ${status.state} by ${money(status.amount)}?`, message: 'Recount first if you can. A saved count is permanent, but you can save a new one later.', choices: [{ label: 'Save count', value: 'yes', tone: 'primary' }, { label: 'Recount', value: null }] });
      if (!sure) return;
    }
    await api('cash_count', { day: $('cashDay').value, opening: float, denominations: pieces, note: $('cashNote').value.trim() });
    toast('Cash count saved', 'success');
    $('cashNote').value = '';
    await open();
  }

  document.querySelectorAll('#counterView [data-view]').forEach(button => button.onclick = () => setView(button.dataset.view));
  $('cashDay').addEventListener('change', () => open().catch(error => toast(error.message, 'error')));
  $('cashFloat').addEventListener('input', render);
  $('cashDenoms').addEventListener('input', render);
  $('cashRefresh').onclick = run(open);
  $('cashSave').onclick = run(save);

  return { open };
}
