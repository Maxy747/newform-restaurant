import { supabase, isSupabaseConfigured } from './supabaseClient.js';
import { createOmsApi } from './oms-client.js';
import { escapeHTML as e, money, statusLabel as label, nextStatuses, canClaim, indiaDayRange, stepTimes, orderNumber, orderRef } from './oms-policy.js';
import { BOARD_COLUMNS, groupOrders, findNewOrders, ageLabel, minutesSince } from './admin-policy.js';
import { createMenuAdmin } from './admin-menu.js';
import { createCounter } from './admin-counter.js';
import { createCashCount } from './admin-cash.js';
import { GSTIN, normalizeBillingSettings, placeOfSupply, financialYear, billingRange, invoicesCSV, creditedTotal, needsCreditNote, rupees2, billDate } from './billing.js';

const THEME_KEY = 'newform_theme_v1';
const SOUND_KEY = 'newform_admin_sound_v1';
const FLASH_MS = 3000;
const ACTIVE_STATUSES = ['new', 'awaiting_payment', 'confirmed', 'preparing', 'ready', 'out_for_delivery'];
const SECTIONS = { orders: ['admin', 'staff', 'kitchen', 'delivery'], counter: ['admin', 'staff'], menu: ['admin'], tickets: ['admin', 'staff'], drivers: ['admin', 'staff'], reports: ['admin', 'staff'], billing: ['admin', 'staff'], settings: ['admin'] };
const TYPE_ICON = { delivery: 'fa-motorcycle', takeaway: 'fa-bag-shopping', dine_in: 'fa-chair' };
const TYPE_LABEL = { delivery: 'Delivery', takeaway: 'Takeaway', dine_in: 'Dine in' };
const PAYMENT_LABEL = { cod: 'COD', cash: 'Pay at counter', upi: 'UPI', whatsapp: 'WhatsApp', razorpay: 'Online' };
const typeName = type => TYPE_LABEL[type] || label(type);
const paymentName = method => PAYMENT_LABEL[method] || label(method);

const $ = id => document.getElementById(id);
const api = createOmsApi(supabase, isSupabaseConfigured);
const state = { role: null, userId: null, config: {}, section: 'orders', ordersView: 'board', historyPage: 0, detailId: null, reportDays: 1, drivers: [], me: null, billing: null, billPage: 0 };
const seenOrders = new Set();
let primed = false, arrivedAt = new Map(), boardOrders = [], lastBoardHTML = '', channel = null, pollTimer = null, refreshTimer = null, boardVersion = 0, detailVersion = 0, authVersion = 0;
const baseTitle = document.title;

// ---------- small UI helpers ----------
function toast(message, tone = 'info') {
  const item = document.createElement('div');
  item.className = `adm-toast adm-toast-${tone}`;
  item.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  item.textContent = message;
  $('toasts').append(item);
  while ($('toasts').children.length > 3) $('toasts').firstElementChild.remove();
  setTimeout(() => item.remove(), tone === 'error' ? 6000 : 3500);
}

// Disables the triggering control while an action runs and reports failures.
const run = fn => async event => {
  const button = event?.currentTarget;
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try { await fn(event); } catch (error) { toast(error.message, 'error'); } finally { if (button) button.disabled = false; }
};

const shortId = id => '#' + String(id).slice(0, 8).toUpperCase();
const time = value => new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const todayIST = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const can = section => SECTIONS[section]?.includes(state.role);
const isManager = () => ['admin', 'staff'].includes(state.role);

// ---------- theme ----------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}
applyTheme((() => { try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch { return 'dark'; } })());
$('themeBtn').onclick = () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* storage blocked */ }
};

// ---------- alerts: sound, title, notifications ----------
let audio = null;
// On by default; only an explicit "off" from this device disables it.
let soundOn = (() => { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; } })();
function syncSoundButton() {
  $('soundBtn').setAttribute('aria-pressed', String(soundOn));
  $('soundBtn').setAttribute('aria-label', soundOn ? 'Turn off new-order sound' : 'Turn on new-order sound');
  $('soundBtn').querySelector('i').className = soundOn ? 'fa-solid fa-volume-high' : 'fa-solid fa-volume-xmark';
}
function syncSoundPrompt() {
  // Browsers block audio until the page is clicked once; say so instead of failing silently.
  $('soundUnlock').hidden = !soundOn || audio?.state === 'running' || !state.role;
}
function unlockAudio() {
  if (!audio) { try { audio = new AudioContext(); } catch { return; } }
  if (audio.state === 'suspended') audio.resume().then(syncSoundPrompt, () => {});
  syncSoundPrompt();
}
function chime() {
  if (!soundOn || !audio || audio.state !== 'running') return;
  const start = audio.currentTime;
  [[880, 0], [1175, 0.18], [1480, 0.36]].forEach(([frequency, offset]) => {
    const osc = audio.createOscillator(), gain = audio.createGain();
    osc.type = 'sine'; osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.35, start + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.3);
    osc.connect(gain).connect(audio.destination);
    osc.start(start + offset); osc.stop(start + offset + 0.32);
  });
}
// Browsers only allow audio after a user gesture on the page.
document.addEventListener('pointerdown', () => { if (soundOn) unlockAudio(); }, { capture: true });
$('soundBtn').onclick = () => {
  soundOn = !soundOn;
  try { localStorage.setItem(SOUND_KEY, soundOn ? 'on' : 'off'); } catch { /* storage blocked */ }
  if (soundOn) { unlockAudio(); setTimeout(chime, 50); }
  syncSoundButton(); syncSoundPrompt();
  toast(soundOn ? 'New-order sound on' : 'New-order sound off');
};
$('soundUnlock').onclick = () => { unlockAudio(); setTimeout(chime, 80); };
syncSoundButton();

function syncNotifyButton() {
  const button = $('notifyBtn');
  if (!('Notification' in window)) { button.disabled = true; button.textContent = 'Not supported'; return; }
  const permission = Notification.permission;
  button.disabled = permission !== 'default';
  button.textContent = permission === 'granted' ? 'Notifications on' : permission === 'denied' ? 'Blocked in browser settings' : 'Enable notifications';
}
$('notifyBtn').onclick = run(async () => { await Notification.requestPermission(); syncNotifyButton(); });
syncNotifyButton();

function announce(orders) {
  if (!orders.length) return;
  chime();
  if (soundOn && audio?.state !== 'running') $('soundUnlock').classList.add('is-urgent');
  navigator.vibrate?.([200, 100, 200]);
  const first = orders[0];
  const summary = orders.length > 1 ? `${orders.length} new orders` : `New ${typeName(first.order_type).toLowerCase()} order ${orderNumber(first)}`;
  toast(summary, 'success');
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const note = new Notification('NEWFORM · ' + summary, { body: orders.map(o => `${orderNumber(o)} · ${money(o.total)}`).join('\n'), icon: 'assets/newform_logo.png', tag: 'newform-new-order' });
      note.onclick = () => { window.focus(); note.close(); };
    } catch { /* some mobile browsers only allow notifications from a service worker */ }
  }
}

function setNewCount(count) {
  $('newCount').hidden = !count;
  $('newCount').textContent = count;
  document.title = count ? `(${count}) ${baseTitle}` : baseTitle;
}

// ---------- auth gate ----------
function showGate(message, { form = false, signOut = false } = {}) {
  $('gate').hidden = false;
  $('gateMessage').textContent = message;
  $('signInForm').hidden = !form;
  $('gateSignOut').hidden = !signOut;
  $('topActions').hidden = true;
  $('adminNav').hidden = true;
  document.querySelectorAll('.adm-section').forEach(section => { section.hidden = true; });
  stopLive();
  setNewCount(0);
}

async function evaluateSession(session) {
  const version = ++authVersion;
  state.role = null;
  if (!isSupabaseConfigured) return showGate('The ordering backend is not configured for this build.');
  if (!session) return showGate('Sign in with your restaurant account.', { form: true });
  showGate('Checking your access…');
  let config;
  try { config = await api('config'); }
  catch (error) { if (version === authVersion) showGate(`Could not reach the restaurant server: ${error.message}`, { signOut: true }); return; }
  if (version !== authVersion) return;
  if (!SECTIONS.orders.includes(config.role)) return showGate(`${session.user.email} does not have restaurant staff access.`, { signOut: true });
  state.role = config.role;
  state.userId = session.user.id;
  state.config = config;
  state.drivers = []; state.me = null;
  $('gate').hidden = true;
  $('topActions').hidden = false;
  $('adminNav').hidden = false;
  document.body.dataset.role = state.role;
  document.querySelectorAll('#adminNav [data-section]').forEach(link => { link.hidden = !can(link.dataset.section); });
  // Kitchen and delivery only work the live board.
  document.querySelector('[data-orders-view="history"]').hidden = !isManager();
  $('codSwitch').setAttribute('aria-checked', String(Boolean(config.codEnabled)));
  $('deliverySwitch').setAttribute('aria-checked', String(config.deliveryEnabled !== false));
  $('addDriverBtn').hidden = state.role !== 'admin';
  $('shiftBox').hidden = true;
  if (state.role === 'delivery') loadMyShift(version).catch(error => toast(error.message, 'error'));
  state.billing = null;
  if (isManager()) loadBillingSettings(version);
  primed = false; seenOrders.clear();
  syncSoundPrompt();
  startLive(session.user.id);
  route();
}

$('signInForm').onsubmit = async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  try {
    const { error } = await supabase.auth.signInWithPassword({ email: $('signInEmail').value.trim(), password: $('signInPassword').value });
    if (error) throw error;
    $('signInPassword').value = '';
  } catch (error) { $('gateMessage').textContent = error.message; }
  finally { button.disabled = false; }
};
const signOut = run(async () => { await supabase.auth.signOut(); });
$('signOutBtn').onclick = signOut;
$('gateSignOut').onclick = signOut;

// ---------- routing ----------
function route() {
  if (!state.role) return;
  let section = location.hash.slice(1) || 'orders';
  if (!can(section)) section = 'orders';
  state.section = section;
  document.querySelectorAll('.adm-section').forEach(element => { element.hidden = element.id !== `section-${section}`; });
  document.querySelectorAll('#adminNav [data-section]').forEach(link => link.toggleAttribute('aria-current', link.dataset.section === section));
  if (section === 'orders') refreshOrders().catch(error => toast(error.message, 'error'));
  if (section === 'menu') menuAdmin.open().catch(error => toast(error.message, 'error'));
  if (section === 'counter') {
    counter.open().catch(error => toast(error.message, 'error'));
    cashCount.open().catch(error => toast(error.message, 'error'));
  }
  if (section === 'tickets') refreshTickets().catch(error => toast(error.message, 'error'));
  if (section === 'drivers') refreshDrivers().catch(error => toast(error.message, 'error'));
  if (section === 'reports') refreshReports().catch(error => toast(error.message, 'error'));
  if (section === 'billing') refreshBilling().catch(error => toast(error.message, 'error'));
}
window.addEventListener('hashchange', route);

// ---------- live updates ----------
function setLive(ok) {
  $('liveStatus').classList.toggle('is-down', !ok);
  $('liveStatus').title = ok ? 'Live updates on' : 'Reconnecting…';
}
function queueRefresh(delay = 400) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refreshLive().catch(() => setLive(false)), delay);
}
async function refreshLive() {
  if (!state.role) return;
  // The board drives new-order alerts, so keep it fresh even while another section is open.
  await refreshBoard();
  if (state.section === 'orders' && state.ordersView === 'history') await refreshHistory();
  if (state.section === 'tickets') await refreshTickets();
  if (state.section === 'drivers') await refreshDrivers();
  if (state.detailId && $('orderDialog').open) await refreshDetail();
  setLive(true);
}
function startLive(userId) {
  stopLive();
  channel = supabase.channel('newform-admin-' + userId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'order_signals' }, () => queueRefresh())
    .subscribe(status => { if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setLive(false); });
  // Polling backs up realtime (e.g. after a phone sleeps); requests stay well under the API rate limit.
  pollTimer = setInterval(() => { if (!document.hidden) queueRefresh(0); }, 20000);
}
function stopLive() {
  clearInterval(pollTimer); pollTimer = null;
  clearTimeout(refreshTimer);
  if (channel) { supabase.removeChannel(channel); channel = null; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.role) queueRefresh(0); });
window.addEventListener('online', () => { if (state.role) queueRefresh(0); });

// ---------- orders: live board ----------
async function fetchBoardOrders() {
  const today = indiaDayRange(todayIST());
  if (!isManager()) {
    // The server scopes kitchen/delivery lists to their own active orders.
    const { orders } = await api('list', { mode: state.role });
    return orders.filter(o => ACTIVE_STATUSES.includes(o.order_status) || Date.parse(o.created_at) >= Date.parse(today.start));
  }
  const requests = ACTIVE_STATUSES.map(status => api('list', { mode: 'orders', status }));
  requests.push(api('list', { mode: 'orders', status: 'completed', start: today.start, end: today.end }));
  requests.push(api('list', { mode: 'orders', status: 'cancelled', start: today.start, end: today.end }));
  const results = await Promise.all(requests);
  return results.flatMap(result => result.orders);
}

function itemList(order) {
  return `<ul class="adm-order-items">${order.items.map(item => `<li><b>${e(item.quantity)}×</b><span>${e(item.name)}${item.portion && item.portion !== 'single' ? ` <small>(${e(item.portion)})</small>` : ''}</span></li>`).join('')}</ul>`;
}

function actionButtons(order, compact = false) {
  const claim = canClaim(order, state.role, state.userId) ? `<button type="button" class="adm-btn adm-step-btn" data-claim="${e(order.id)}"><i class="fa-solid fa-hand"></i> Take this delivery</button>` : '';
  return claim + nextStatuses(order, state.role, state.userId).map(status => {
    const cancel = status === 'cancelled';
    if (compact && cancel) return '';
    return `<button type="button" class="adm-btn ${cancel ? 'adm-btn-danger' : 'adm-step-btn'}" data-order="${e(order.id)}" data-status="${e(status)}">${cancel ? 'Cancel order' : 'Mark ' + e(label(status).toLowerCase())}</button>`;
  }).join('');
}

function orderCard(order) {
  order = withPending(order);
  const waiting = minutesSince(order.created_at);
  const late = ['new', 'confirmed', 'preparing'].includes(order.order_status) && waiting >= 20;
  const payment = order.payment_status === 'paid' ? '<span class="adm-chip adm-chip-ok">Paid</span>' : `<span class="adm-chip">${e(paymentName(order.payment_method))}</span>`;
  // New arrivals flash for FLASH_MS; a negative delay keeps the flash continuous across re-renders.
  const flashAge = arrivedAt.has(order.id) ? Date.now() - arrivedAt.get(order.id) : Infinity;
  const flash = flashAge < FLASH_MS ? ` style="animation-delay:-${flashAge}ms"` : '';
  return `<article class="adm-order${late ? ' is-late' : ''}${order.order_status === 'new' ? ' is-new' : ''}${flash ? ' just-arrived' : ''}${pending.has(order.id) ? ' is-pending' : ''}"${flash} data-open="${e(order.id)}" tabindex="0" aria-label="Order ${e(orderNumber(order))}">
    <header><strong class="adm-order-no">${e(orderNumber(order))}</strong><span class="adm-age" title="${e(time(order.created_at))}"><i class="fa-regular fa-clock"></i> ${e(ageLabel(order.created_at))}</span></header>
    <div class="adm-order-meta"><span><i class="fa-solid ${TYPE_ICON[order.order_type] || 'fa-receipt'}"></i> ${e(typeName(order.order_type))}${order.table_number ? ' · Table ' + e(order.table_number) : ''}</span>${payment}</div>
    ${order.customer_name ? `<p class="adm-order-name">${e(order.customer_name)}</p>` : ''}
    ${driverLine(order)}
    ${itemList(order)}
    <footer><strong>${money(order.total)}</strong>${order.order_status === 'awaiting_payment' ? '<span class="adm-chip">Awaiting payment</span>' : ''}<span class="adm-order-actions">${actionButtons(order, true)}</span></footer>
  </article>`;
}

// Who is delivering: shown on open delivery cards once a driver is assigned, or flagged when a ready order has none.
function driverLine(order) {
  if (order.order_type !== 'delivery' || ['completed', 'cancelled'].includes(order.order_status)) return '';
  if (order.assigned_driver && order.assigned_driver === state.userId) return '<div class="adm-order-driver"><span class="adm-chip adm-chip-mine"><i class="fa-solid fa-motorcycle"></i>&nbsp;Your delivery</span></div>';
  if (order.driver?.display_name) return `<div class="adm-order-driver"><span class="adm-chip"><i class="fa-solid fa-motorcycle"></i>&nbsp;${e(order.driver.display_name)}</span></div>`;
  if (['ready', 'out_for_delivery'].includes(order.order_status)) return '<div class="adm-order-driver"><span class="adm-chip adm-chip-warn">No driver yet</span></div>';
  return '';
}

function finishedRow(order) {
  order = withPending(order);
  return `<button type="button" class="adm-row" data-open="${e(order.id)}"><strong>${e(orderNumber(order))}</strong><span>${e(order.customer_name || typeName(order.order_type))}</span><span class="adm-badge adm-badge-${e(order.order_status)}">${e(label(order.order_status))}</span><strong>${money(order.total)}</strong></button>`;
}

async function refreshBoard() {
  const version = ++boardVersion;
  const orders = await fetchBoardOrders();
  if (version !== boardVersion) return;
  boardOrders = [...new Map(orders.map(order => [order.id, order])).values()];
  const fresh = findNewOrders(seenOrders, boardOrders, primed);
  announce(fresh);
  // Only genuinely new arrivals get the slide-in animation, once.
  const now = Date.now();
  fresh.forEach(order => arrivedAt.set(order.id, now));
  arrivedAt.forEach((at, id) => { if (now - at >= FLASH_MS) arrivedAt.delete(id); });
  primed = true;
  renderBoard();
  // Columns list oldest first, so bring a just-arrived card into view for its flash.
  const newest = fresh.at(-1) && document.querySelector(`#orderBoard [data-open="${CSS.escape(fresh.at(-1).id)}"]`);
  newest?.scrollIntoView({ block: 'nearest' });
  if (isManager() && state.section === 'orders' && state.ordersView === 'board') await refreshTodayStats(version);
}

function renderBoard() {
  const { columns, finished } = groupOrders(boardOrders.map(withPending));
  setNewCount(columns.new.filter(order => order.order_status === 'new').length);
  if (state.section !== 'orders' || state.ordersView !== 'board') return;
  // Delivery staff only act on ready / out-for-delivery orders; kitchen never sees out-for-delivery.
  const visible = BOARD_COLUMNS.filter(column => state.role === 'delivery' ? ['ready', 'out'].includes(column.key) : state.role === 'kitchen' ? column.key !== 'out' : true);
  $('orderBoard').style.setProperty('--board-cols', visible.length);
  const boardHTML = visible.map(column => `<section class="adm-column adm-column-${column.key}" aria-label="${e(column.title)}">
    <h3>${e(column.title)} <span>${columns[column.key].length}</span></h3>
    <div class="adm-column-body">${columns[column.key].map(orderCard).join('') || '<p class="adm-empty">Nothing here</p>'}</div>
  </section>`).join('');
  // Ages change every minute; skip identical re-renders so hover and focus aren't disturbed.
  if (boardHTML !== lastBoardHTML) {
    // Rebuilding the columns would reset their scroll, so carry each column's position over.
    const scrolls = new Map([...$('orderBoard').querySelectorAll('.adm-column')].map(column => [column.className, column.querySelector('.adm-column-body').scrollTop]));
    $('orderBoard').innerHTML = boardHTML; lastBoardHTML = boardHTML;
    $('orderBoard').querySelectorAll('.adm-column').forEach(column => { column.querySelector('.adm-column-body').scrollTop = scrolls.get(column.className) || 0; });
  }
  $('finishedCount').textContent = `(${finished.length})`;
  $('finishedList').innerHTML = finished.map(finishedRow).join('') || '<p class="adm-empty">No finished orders yet today.</p>';
  $('finishedWrap').hidden = !isManager() && state.role !== 'delivery';
}

async function refreshTodayStats(version) {
  const range = indiaDayRange(todayIST());
  const stats = await api('analytics', { start: range.start, end: range.end });
  if (version !== boardVersion) return;
  $('todayStats').innerHTML = [['Orders today', stats.orders], ...(stats.sales != null ? [['Sales', money(stats.sales)]] : []), ['Received', money(stats.revenue)], ['Completed', stats.completed], ['Cancelled', stats.cancelled]]
    .map(([title, value]) => `<div class="adm-stat"><small>${e(title)}</small><strong>${e(value)}</strong></div>`).join('');
}

async function refreshOrders() {
  if (state.ordersView === 'history') await refreshHistory();
  else await refreshBoard();
}

document.querySelectorAll('[data-orders-view]').forEach(button => button.onclick = () => {
  state.ordersView = button.dataset.ordersView;
  document.querySelectorAll('[data-orders-view]').forEach(other => other.setAttribute('aria-selected', String(other === button)));
  $('ordersBoardView').hidden = state.ordersView !== 'board';
  $('ordersHistoryView').hidden = state.ordersView !== 'history';
  refreshOrders().catch(error => toast(error.message, 'error'));
});

// ---------- orders: history ----------
$('histStatus').innerHTML += ['new', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled', 'awaiting_payment'].map(status => `<option value="${status}">${e(label(status))}</option>`).join('');
$('histFrom').value = $('histTo').value = todayIST();
$('historyFilters').onsubmit = event => { event.preventDefault(); state.historyPage = 0; refreshHistory().catch(error => toast(error.message, 'error')); };
$('histPrev').onclick = run(async () => { state.historyPage = Math.max(0, state.historyPage - 1); await refreshHistory(); });
$('histNext').onclick = run(async () => { state.historyPage++; await refreshHistory(); });

async function refreshHistory() {
  if (!isManager()) return;
  const start = $('histFrom').value ? indiaDayRange($('histFrom').value).start : null;
  const end = $('histTo').value ? indiaDayRange($('histTo').value).end : null;
  const { orders, count } = await api('list', { mode: 'orders', page: state.historyPage, start, end, status: $('histStatus').value, type: $('histType').value, search: $('histSearch').value.trim() });
  $('historyList').innerHTML = orders.map(order => `<button type="button" class="adm-row" data-open="${e(order.id)}">
      <strong>${e(orderNumber(order))}</strong><span>${e(time(order.created_at))}</span><span>${e(order.customer_name || '')}</span>
      <span class="adm-badge adm-badge-${e(order.order_status)}">${e(label(order.order_status))}</span><strong>${money(order.total)}</strong></button>`).join('')
    || '<p class="adm-empty">No orders match these filters.</p>';
  $('histPrev').disabled = state.historyPage === 0;
  $('histNext').disabled = (state.historyPage + 1) * 30 >= count;
  $('histPage').textContent = `${count} orders · page ${state.historyPage + 1}`;
}

// ---------- order detail ----------
async function openOrder(id) {
  state.detailId = id;
  $('orderDialogTitle').textContent = 'Order ' + shortId(id);
  $('orderDialogBody').innerHTML = '<p class="adm-empty">Loading order…</p>';
  if (!$('orderDialog').open) $('orderDialog').showModal();
  await refreshDetail();
}

async function refreshDetail() {
  const id = state.detailId, version = ++detailVersion;
  // Managers need the roster for the driver picker; it is fetched once and dropped after any assignment.
  const [{ order: fetched, events, tickets, invoice }] = await Promise.all([api('detail', { id }), isManager() && !state.drivers.length ? loadDrivers().catch(() => {}) : null]);
  if (version !== detailVersion || id !== state.detailId) return;
  const o = withPending(fetched);
  $('orderDialogTitle').textContent = `Order ${orderNumber(o)}`;
  const body = $('orderDialogBody');
  // Keep a half-written ticket reply intact during live refreshes.
  if (body.contains(document.activeElement) && document.activeElement.matches('textarea, input, select')) return;
  if ([...body.querySelectorAll('textarea')].some(field => field.value)) return;
  const steps = ['new', 'confirmed', 'preparing', 'ready', ...(o.order_type === 'delivery' ? ['out_for_delivery'] : []), 'completed'];
  const current = steps.indexOf(o.order_status);
  const reached = stepTimes(events);
  const canCash = state.role !== 'kitchen' && (state.role !== 'delivery' || o.assigned_driver === state.userId) && o.payment_method !== 'razorpay' && o.payment_status !== 'paid' && o.order_status !== 'cancelled';
  const deliveryPin = o.delivery_latitude != null && o.delivery_longitude != null ? `https://www.google.com/maps?q=${Number(o.delivery_latitude)},${Number(o.delivery_longitude)}` : null;
  body.innerHTML = `
    <div class="adm-detail-status"><span class="adm-badge adm-badge-${e(o.order_status)}">${e(label(o.order_status))}</span><span class="adm-muted">Placed ${e(time(o.created_at))} · ${e(ageLabel(o.created_at))} ago · Ref ${e(orderRef(o))}</span></div>
    ${o.order_status === 'cancelled' ? '' : `<ol class="adm-steps">${steps.map((step, index) => `<li class="${index < current ? 'done' : index === current ? 'current' : ''}"><span>${e(label(step))}</span>${reached.has(step) ? `<small>${e(new Date(reached.get(step)).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }))}</small>` : ''}</li>`).join('')}</ol>`}
    <div class="adm-detail-actions">${actionButtons(o)}${canCash ? '<button type="button" class="adm-btn" id="cashBtn"><i class="fa-solid fa-money-bill-wave"></i> Cash received</button>' : ''}</div>
    <section class="adm-detail-block"><h3>Items</h3>
      <ul class="adm-items">${o.items.map(item => `<li><span>${e(item.quantity)} × ${e(item.name)}${item.portion && item.portion !== 'single' ? ` <small>(${e(item.portion)})</small>` : ''}</span><strong>${money(item.quantity * item.price)}</strong></li>`).join('')}</ul>
      <dl class="adm-totals"><dt>Subtotal</dt><dd>${money(o.subtotal)}</dd><dt>GST</dt><dd>${money(o.tax)}</dd>${o.order_type === 'delivery' ? `<dt>Delivery${o.delivery_distance_m != null ? ` · ${(o.delivery_distance_m / 1000).toFixed(1)} km` : ''}</dt><dd>${money(o.delivery_fee || 0)}</dd>` : ''}<dt class="adm-total">Total</dt><dd class="adm-total">${money(o.total)}</dd></dl>
    </section>
    ${invoiceBlock(o, invoice)}
    <section class="adm-detail-block"><h3>${e(typeName(o.order_type))}</h3>
      ${o.customer_name ? `<p><strong>${e(o.customer_name)}</strong></p>` : ''}
      ${o.phone ? `<p><a class="adm-link" href="tel:${e(o.phone.replace(/[^0-9+]/g, ''))}"><i class="fa-solid fa-phone"></i> ${e(o.phone)}</a></p>` : ''}
      ${o.table_number ? `<p>Table ${e(o.table_number)}</p>` : ''}
      ${o.delivery_address ? `<p class="adm-pre">${e(o.delivery_address)}</p>` : ''}
      ${deliveryPin ? `<p><a class="adm-link" href="${e(deliveryPin)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-location-dot"></i> Open delivery pin in Maps</a></p>` : ''}
      <p class="adm-muted">Payment: ${e(o.payment_method === 'cod' ? 'Cash on delivery' : paymentName(o.payment_method))} · ${e(label(o.payment_status))}</p>
    </section>
    ${driverBlock(o)}
    <details class="adm-detail-block"><summary>Activity (${events.length})</summary><ul class="adm-events">${events.map(event => `<li><small>${e(time(event.created_at))}</small> ${e(label(event.detail))}</li>`).join('')}</ul></details>
    <div id="orderTickets"></div>`;
  body.querySelectorAll('[data-status]').forEach(button => button.onclick = run(() => requestStatus(o, button.dataset.status)));
  if ($('cashBtn')) $('cashBtn').onclick = run(() => requestCash(o));
  if ($('driverPick')) $('driverPick').onchange = run(async () => {
    const select = $('driverPick'); select.disabled = true;
    try { await assignDriver(o, select.value || null); } catch (error) { select.value = o.assigned_driver || ''; throw error; } finally { select.disabled = false; select.blur(); }
  });
  if ($('releaseBtn')) $('releaseBtn').onclick = run(() => releaseOrder(o));
  if ($('issueInvoiceBtn')) $('issueInvoiceBtn').onclick = run(async () => { await api('issue_invoice', { id: o.id }); toast('Invoice issued', 'success'); await refreshDetail(); });
  if ($('creditBtn')) $('creditBtn').onclick = run(() => openCreditNote(o.id));
  if (isManager()) renderTickets(o, tickets);
}

function driverBlock(o) {
  if (o.order_type !== 'delivery') return '';
  const closed = ['completed', 'cancelled'].includes(o.order_status);
  const phone = o.driver?.phone && state.role !== 'delivery' ? ` · <a class="adm-link" href="tel:${e(o.driver.phone.replace(/[^0-9+]/g, ''))}"><i class="fa-solid fa-phone"></i> ${e(o.driver.phone)}</a>` : '';
  const current = o.driver?.display_name ? `<p><strong>${e(o.driver.display_name)}</strong>${phone}</p>` : '<p class="adm-muted">No driver assigned yet.</p>';
  if (isManager() && !closed) {
    // Only active, on-shift drivers can take new work; the current driver stays listed so the select shows them.
    const options = state.drivers.filter(d => d.active && (d.on_shift || d.id === o.assigned_driver));
    return `<section class="adm-detail-block"><h3>Driver</h3>
      <div class="adm-driver-pick"><select id="driverPick" aria-label="Assign driver"><option value="">No driver</option>${options.map(d => `<option value="${e(d.id)}"${d.id === o.assigned_driver ? ' selected' : ''}>${e(d.name)}${d.on_shift ? ` · ${e(d.active_orders)} active` : ' · off shift'}</option>`).join('')}</select></div>
      ${options.length ? '' : '<p class="adm-muted">No drivers are on shift. Start a shift from the Drivers page.</p>'}
      ${phone ? `<p class="adm-muted">Call ${e(o.driver.display_name)}${phone}</p>` : ''}</section>`;
  }
  if (state.role === 'delivery' && o.assigned_driver === state.userId && o.order_status === 'ready') {
    return '<section class="adm-detail-block"><h3>Driver</h3><p>This delivery is yours.</p><div><button type="button" class="adm-btn" id="releaseBtn">Hand back to the restaurant</button></div></section>';
  }
  return `<section class="adm-detail-block"><h3>Driver</h3>${current}</section>`;
}

async function assignDriver(order, driverId) {
  await api('assign', { id: order.id, driver: driverId });
  const name = state.drivers.find(d => d.id === driverId)?.name;
  toast(driverId ? `${orderNumber(order)} assigned to ${name || 'driver'}` : `${orderNumber(order)} has no driver now`, 'success');
  state.drivers = [];
  queueRefresh(0);
}

async function claimOrder(order) {
  await api('assign', { id: order.id, driver: state.userId });
  toast(`${orderNumber(order)} is yours. Mark it out for delivery when you leave.`, 'success');
  queueRefresh(0);
}

async function releaseOrder(order) {
  const choice = await ask({ title: `Hand back ${orderNumber(order)}?`, message: 'Another driver will be able to take it.', choices: [{ label: 'Hand back', value: 'yes', tone: 'danger' }, { label: 'Keep it', value: null }] });
  if (!choice) return;
  await api('assign', { id: order.id, driver: null });
  toast(`${orderNumber(order)} handed back`);
  queueRefresh(0);
}

function renderTickets(order, tickets) {
  const target = $('orderTickets');
  target.innerHTML = tickets.length ? `<section class="adm-detail-block"><h3>Support</h3>${tickets.map(ticket => `<div class="adm-ticket">
      <header><strong>${e(ticket.subject)}</strong><span class="adm-badge">${e(label(ticket.status))}</span></header>
      ${ticket.ticket_messages.sort((a, b) => a.created_at.localeCompare(b.created_at)).map(message => `<p class="adm-msg adm-msg-${message.author_role === 'customer' ? 'customer' : 'staff'}"><small>${e(message.author_role)} · ${e(time(message.created_at))}</small>${e(message.message)}</p>`).join('')}
      <form data-ticket="${e(ticket.id)}" class="adm-form">
        <label>Reply<textarea name="message" rows="2" maxlength="2000" required></textarea></label>
        <div class="adm-form-row"><label>Status<select name="status">${['open', 'in_progress', 'resolved'].map(status => `<option value="${status}"${status === ticket.status ? ' selected' : ''}>${e(label(status))}</option>`).join('')}</select></label><button type="submit" class="adm-btn adm-btn-primary">Send reply</button></div>
      </form></div>`).join('')}</section>` : '';
  target.querySelectorAll('form').forEach(form => form.onsubmit = async event => {
    event.preventDefault();
    const button = form.querySelector('button'); if (button.disabled) return; button.disabled = true;
    try {
      const fields = new FormData(form);
      await api('ticket', { id: order.id, ticketId: form.dataset.ticket, message: fields.get('message'), status: fields.get('status') });
      form.reset(); document.activeElement?.blur();
      toast('Reply sent', 'success');
      await refreshDetail();
    } catch (error) { toast(error.message, 'error'); } finally { button.disabled = false; }
  });
}

// ---------- undoable actions ----------
// Changes wait a few seconds before reaching the server so any of them can be undone.
const UNDO_MS = 6000;
const pending = new Map(); // order id -> { status, cash, timer, note }

function withPending(order) {
  const change = pending.get(order.id);
  if (!change) return order;
  return { ...order, ...(change.status ? { order_status: change.status } : {}), ...(change.cash ? { payment_status: 'paid' } : {}) };
}

function findOrder(id) {
  return boardOrders.find(order => order.id === id);
}

function rerender() {
  renderBoard();
  if (state.detailId && $('orderDialog').open) refreshDetail().catch(error => toast(error.message, 'error'));
}

function undoToast(message, onUndo) {
  const item = document.createElement('div');
  item.className = 'adm-toast adm-toast-undo';
  item.setAttribute('role', 'status');
  item.style.setProperty('--undo-ms', UNDO_MS + 'ms');
  item.innerHTML = `<span>${e(message)}</span><button type="button" class="adm-undo-btn"><i class="fa-solid fa-rotate-left"></i> Undo</button><i class="adm-undo-bar" aria-hidden="true"></i>`;
  item.querySelector('button').onclick = () => { item.remove(); onUndo(); };
  $('toasts').append(item);
  return item;
}

async function commit(id) {
  const change = pending.get(id);
  if (!change || change.sending) return;
  change.sending = true;
  clearTimeout(change.timer);
  change.note?.remove();
  try {
    if (change.cash) await api('cash', { id });
    if (change.status) await api('transition', { id, status: change.status });
  } catch (error) {
    toast(`${orderNumber(findOrder(id) || { id })}: ${error.message}`, 'error');
  } finally {
    pending.delete(id);
    queueRefresh(0);
  }
}

async function queueChange(order, change, message) {
  // A second change to the same order sends the first one now, so steps stay in order.
  if (pending.has(order.id)) await commit(order.id);
  const entry = { ...change };
  entry.note = undoToast(message, () => {
    if (entry.sending) return;
    clearTimeout(entry.timer);
    pending.delete(order.id);
    toast(`Undone: ${message}`);
    rerender();
  });
  entry.timer = setTimeout(() => commit(order.id), UNDO_MS);
  pending.set(order.id, entry);
  rerender();
}

const flushPending = () => Promise.all([...pending.keys()].map(commit));
document.addEventListener('visibilitychange', () => { if (document.hidden && pending.size) flushPending(); });
window.addEventListener('beforeunload', event => {
  if (!pending.size) return;
  flushPending();
  event.preventDefault();
});

// Small in-page confirm with explicit choices (replaces the browser's confirm()).
function ask({ title, message, choices }) {
  const dialog = $('askDialog');
  $('askTitle').textContent = title;
  $('askMessage').textContent = message;
  $('askChoices').innerHTML = choices.map((choice, index) => `<button type="button" class="adm-btn ${choice.tone === 'danger' ? 'adm-btn-danger' : choice.tone === 'primary' ? 'adm-btn-primary' : ''}" data-choice="${index}">${e(choice.label)}</button>`).join('');
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (settled) return; settled = true; if (dialog.open) dialog.close(); resolve(value); };
    dialog.addEventListener('close', () => finish(null), { once: true });
    $('askChoices').querySelectorAll('[data-choice]').forEach(button => button.onclick = () => finish(choices[Number(button.dataset.choice)].value));
    dialog.showModal();
    $('askChoices').querySelector('.adm-btn-primary, .adm-btn-danger, .adm-btn')?.focus();
  });
}

const unpaidCash = order => order.payment_status !== 'paid' && order.payment_method !== 'razorpay' && state.role !== 'kitchen';

async function requestStatus(order, status) {
  order = withPending(order);
  if (status === 'cancelled') {
    const choice = await ask({ title: `Cancel ${orderNumber(order)}?`, message: 'The customer will see this order as cancelled.', choices: [{ label: 'Cancel order', value: 'yes', tone: 'danger' }, { label: 'Keep order', value: null }] });
    if (!choice) return;
    return queueChange(order, { status }, `${orderNumber(order)} cancelled`);
  }
  if (status === 'completed' && unpaidCash(order)) {
    // Double-check the money before closing an unpaid cash / COD / WhatsApp order.
    const choice = await ask({ title: `Did you receive ${money(order.total)}?`, message: `${orderNumber(order)} · ${paymentName(order.payment_method)} · not marked paid yet.`,
      choices: [{ label: `Yes, ${money(order.total)} received`, value: 'paid', tone: 'primary' }, { label: 'Not yet, complete anyway', value: 'unpaid' }, { label: 'Go back', value: null }] });
    if (!choice) return;
    return queueChange(order, { status, cash: choice === 'paid' }, `${orderNumber(order)} completed · ${choice === 'paid' ? 'paid' : 'unpaid'}`);
  }
  return queueChange(order, { status }, `${orderNumber(order)} → ${label(status)}`);
}

async function requestCash(order) {
  const choice = await ask({ title: `Did you receive ${money(order.total)}?`, message: `${orderNumber(order)} will be marked as paid.`, choices: [{ label: 'Yes, received', value: 'paid', tone: 'primary' }, { label: 'Go back', value: null }] });
  if (choice) await queueChange(withPending(order), { cash: true }, `${orderNumber(order)} marked paid`);
}

$('orderDialog').addEventListener('close', () => { state.detailId = null; detailVersion++; });

// One delegated handler for every order card/row in the page.
document.addEventListener('click', event => {
  const claim = event.target.closest('[data-claim]');
  if (claim) {
    event.stopPropagation();
    const order = findOrder(claim.dataset.claim);
    if (order) run(() => claimOrder(order))({ currentTarget: claim });
    return;
  }
  const action = event.target.closest('[data-status]');
  if (action && !action.closest('#orderDialog')) {
    event.stopPropagation();
    const order = findOrder(action.dataset.order);
    if (order) run(() => requestStatus(order, action.dataset.status))({ currentTarget: action });
    return;
  }
  const opener = event.target.closest('[data-open]');
  if (opener) openOrder(opener.dataset.open).catch(error => toast(error.message, 'error'));
});
document.addEventListener('keydown', event => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('article[data-open]')) { event.preventDefault(); event.target.click(); }
});

// ---------- tickets ----------
async function refreshTickets() {
  if (!isManager()) return;
  const { tickets } = await api('ticket_list');
  $('ticketList').innerHTML = tickets.map(ticket => `<button type="button" class="adm-row" data-open="${e(ticket.order_id)}">
      <strong>${e(ticket.subject)}</strong><span>Order ${e(shortId(ticket.order_id))}</span><span class="adm-badge">${e(label(ticket.status))}</span><span class="adm-muted">${e(time(ticket.updated_at || ticket.created_at))}</span></button>`).join('')
    || '<p class="adm-empty">No open tickets. Nice.</p>';
}

// ---------- delivery drivers ----------
async function loadDrivers() {
  const today = indiaDayRange(todayIST());
  state.drivers = (await api('drivers', { start: today.start, end: today.end })).drivers;
  return state.drivers;
}

async function refreshDrivers() {
  if (!isManager()) return;
  const drivers = await loadDrivers();
  const admin = state.role === 'admin';
  $('driverList').innerHTML = drivers.map(d => `<article class="adm-card adm-driver${d.active ? '' : ' is-disabled'}">
      <header><div><h3>${e(d.name)}</h3><p>${e(d.email || '')}${d.phone ? ` · <a class="adm-link" href="tel:${e(d.phone.replace(/[^0-9+]/g, ''))}">${e(d.phone)}</a>` : ''}</p></div>
        ${d.active ? (d.on_shift ? '<span class="adm-chip adm-chip-ok">On shift</span>' : '<span class="adm-chip">Off shift</span>') : '<span class="adm-chip">Disabled</span>'}</header>
      <div class="adm-driver-stats"><div><small>Active now</small><strong>${e(d.active_orders)}</strong></div><div><small>Delivered today</small><strong>${e(d.delivered)}</strong></div><div><small>Cash today</small><strong>${money(d.cash)}</strong></div></div>
      <footer>
        ${d.active ? `<span class="adm-shift" data-on="${d.on_shift}">Shift <button type="button" class="adm-switch adm-switch-sm" role="switch" aria-checked="${d.on_shift}" aria-label="${e(d.name)} on shift" data-driver-shift="${e(d.id)}"><span></span></button></span>` : ''}
        ${admin ? `<button type="button" class="adm-btn" data-driver-edit="${e(d.id)}"><i class="fa-solid fa-pen"></i> Edit</button>
        <button type="button" class="adm-btn${d.active ? ' adm-btn-danger' : ''}" data-driver-active="${e(d.id)}">${d.active ? 'Disable' : 'Enable'}</button>` : ''}
      </footer></article>`).join('')
    || `<p class="adm-empty">No drivers yet.${admin ? ' Use Add driver once they have signed up on the website.' : ''}</p>`;
}

$('driverList').addEventListener('click', event => {
  const shift = event.target.closest('[data-driver-shift]'), edit = event.target.closest('[data-driver-edit]'), active = event.target.closest('[data-driver-active]');
  const driver = id => state.drivers.find(d => d.id === id);
  if (shift) run(async () => {
    const d = driver(shift.dataset.driverShift);
    await api('driver_status', { driverId: d.id, onShift: !d.on_shift });
    toast(`${d.name} is ${d.on_shift ? 'off' : 'on'} shift`, 'success');
    await refreshDrivers();
  })({ currentTarget: shift });
  if (edit) openDriverForm(driver(edit.dataset.driverEdit));
  if (active) run(async () => {
    const d = driver(active.dataset.driverActive);
    if (d.active) {
      const choice = await ask({ title: `Disable ${d.name}?`, message: 'They lose driver access right away. Their past deliveries stay in the records.', choices: [{ label: 'Disable driver', value: 'yes', tone: 'danger' }, { label: 'Keep', value: null }] });
      if (!choice) return;
    }
    await api('driver_status', { driverId: d.id, active: !d.active });
    toast(`${d.name} ${d.active ? 'disabled' : 'enabled'}`, 'success');
    await refreshDrivers();
  })({ currentTarget: active });
});

let editingDriver = null;
function openDriverForm(driver = null) {
  editingDriver = driver;
  const form = $('driverForm');
  form.reset();
  $('driverDialogTitle').textContent = driver ? `Edit ${driver.name}` : 'Add driver';
  $('driverEmailField').hidden = $('driverEmailHelp').hidden = Boolean(driver);
  form.elements.name.value = driver?.name || '';
  form.elements.phone.value = driver?.phone || '';
  $('driverError').hidden = true;
  $('driverDialog').showModal();
  (driver ? form.elements.name : form.elements.email).focus();
}
$('addDriverBtn').onclick = () => openDriverForm();
$('driverForm').onsubmit = async event => {
  event.preventDefault();
  const form = event.currentTarget, button = $('driverSave');
  if (button.disabled) return;
  button.disabled = true; $('driverError').hidden = true;
  try {
    await api('driver_save', { driverId: editingDriver?.id, email: form.elements.email.value.trim(), name: form.elements.name.value.trim(), phone: form.elements.phone.value.trim() });
    toast(editingDriver ? 'Driver updated' : 'Driver added. They can sign in to the admin page now.', 'success');
    $('driverDialog').close();
    await refreshDrivers();
  } catch (error) { $('driverError').textContent = error.message; $('driverError').hidden = false; }
  finally { button.disabled = false; }
};

// Drivers switch their own shift from the orders page.
async function loadMyShift(version) {
  const { drivers } = await api('drivers');
  if (version !== authVersion) return;
  state.me = drivers[0] || null;
  syncMyShift();
}
function syncMyShift() {
  const on = Boolean(state.me?.on_shift);
  $('shiftBox').hidden = !state.me;
  $('shiftBox').dataset.on = String(on);
  $('shiftLabel').textContent = on ? 'On shift' : 'Off shift';
  $('shiftSwitch').setAttribute('aria-checked', String(on));
}
$('shiftSwitch').onclick = run(async () => {
  if (!state.me) return;
  const onShift = !state.me.on_shift;
  await api('driver_status', { driverId: state.me.id, onShift });
  state.me.on_shift = onShift;
  syncMyShift();
  toast(onShift ? 'Shift started. You can take ready orders.' : 'Shift ended', 'success');
});

// ---------- reports ----------
const rupees = value => '₹' + Math.round(Number(value) || 0).toLocaleString('en-IN');
const compactRupees = value => { const n = Number(value) || 0; return n >= 100000 ? `₹${(n / 100000).toFixed(n >= 1000000 ? 0 : 1)}L` : n >= 1000 ? `₹${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `₹${Math.round(n)}`; };
const hourName = hour => `${hour % 12 || 12}${hour < 12 ? 'am' : 'pm'}`;

// Rounded "nice" axis maximum so gridlines land on clean numbers.
function niceMax(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 2.5, 5, 10].map(step => step * magnitude).find(step => step >= value);
}

// Single-series column chart: thin bars with rounded tops, recessive grid, peak labelled, hover tooltip per bar.
function columnChart({ points, format, axisFormat, title, width = 720 }) {
  width = Math.max(280, Math.round(width));
  const height = width < 520 ? 200 : 240, left = 48, right = 8, top = 22, bottom = 26;
  const max = niceMax(Math.max(0, ...points.map(point => point.value)));
  const plotW = width - left - right, plotH = height - top - bottom;
  const slot = plotW / Math.max(points.length, 1), barW = Math.max(3, Math.min(28, slot * 0.62));
  const y = value => top + plotH - (value / max) * plotH;
  const peak = points.reduce((best, point, index) => point.value > (points[best]?.value ?? -1) ? index : best, 0);
  const every = Math.ceil(points.length / 12);
  const grid = [0, 0.5, 1].map(f => `<line x1="${left}" x2="${width - right}" y1="${y(max * f)}" y2="${y(max * f)}" class="adm-grid"/><text x="${left - 6}" y="${y(max * f) + 4}" class="adm-axis" text-anchor="end">${e(axisFormat(max * f))}</text>`).join('');
  const bars = points.map((point, index) => {
    const x = left + index * slot + (slot - barW) / 2, h = Math.max(point.value ? 2 : 0, top + plotH - y(point.value));
    const r = Math.min(4, barW / 2, h);
    // Path rounds only the data end (top) and stays square on the baseline.
    const path = h ? `M${x},${top + plotH} V${top + plotH - h + r} Q${x},${top + plotH - h} ${x + r},${top + plotH - h} H${x + barW - r} Q${x + barW},${top + plotH - h} ${x + barW},${top + plotH - h + r} V${top + plotH} Z` : '';
    return `<g class="adm-bar-g" data-tip="${e(point.tip ?? `${point.label}: ${format(point.value)}`)}">
      <rect x="${left + index * slot}" y="${top}" width="${slot}" height="${plotH}" class="adm-hit"/>
      ${path ? `<path d="${path}" class="adm-col"/>` : ''}
      ${index === peak && point.value ? `<text x="${x + barW / 2}" y="${top + plotH - h - 6}" class="adm-peak" text-anchor="middle">${e(format(point.value))}</text>` : ''}
      ${index % every === 0 ? `<text x="${x + barW / 2}" y="${height - 8}" class="adm-axis" text-anchor="middle">${e(point.short ?? point.label)}</text>` : ''}
    </g>`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" class="adm-chart" role="img" aria-label="${e(title)}">${grid}<line x1="${left}" x2="${width - right}" y1="${top + plotH}" y2="${top + plotH}" class="adm-baseline"/>${bars}</svg>`;
}

// Horizontal bars with direct labels: used for categories (order type, payment, dishes).
function barList(rows, format) {
  const max = Math.max(1, ...rows.map(row => row.value));
  return `<ul class="adm-bars">${rows.map(row => `<li data-tip="${e(row.tip ?? `${row.label}: ${format(row.value)}`)}"><span>${e(row.label)}</span><span class="adm-bar"><i style="width:${Math.max(2, (row.value / max) * 100)}%"></i></span><strong>${e(format(row.value))}</strong></li>`).join('')}</ul>`;
}

function tableView(headers, rows) {
  return `<details class="adm-table-view"><summary>Show as table</summary><table><thead><tr>${headers.map(h => `<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${e(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></details>`;
}

function dayList(startISO, days) {
  // India-time calendar days in the range, so days with no orders still show as zero.
  const first = new Date(Date.parse(startISO) + 5.5 * 3600000);
  return Array.from({ length: days }, (_, index) => new Date(first.getTime() + index * 86400000).toISOString().slice(0, 10));
}

document.querySelectorAll('#reportRange [data-range]').forEach(button => button.onclick = () => {
  state.reportDays = Number(button.dataset.range);
  document.querySelectorAll('#reportRange [data-range]').forEach(other => other.setAttribute('aria-selected', String(other === button)));
  refreshReports().catch(error => toast(error.message, 'error'));
});

async function refreshReports() {
  if (!isManager()) return;
  const end = indiaDayRange(todayIST()).end;
  const start = new Date(Date.parse(end) - state.reportDays * 86400000).toISOString();
  lastReport = { stats: await api('analytics', { start, end }), start };
  renderReports();
}

let lastReport = null, resizeTimer = null;
// Charts are drawn at the card's real pixel width so text stays crisp and heights stay fixed.
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.section === 'reports' && lastReport) renderReports(); }, 150);
});

function renderReports() {
  const { stats, start } = lastReport;
  const today = state.reportDays === 1;
  const bodyWidth = $('reportBody').clientWidth, twoColumns = bodyWidth >= 868;
  $('reportBody').style.gridTemplateColumns = twoColumns ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)';
  const full = bodyWidth - 34, half = twoColumns ? (bodyWidth - 14) / 2 - 34 : full;
  const kpis = [
    ['Sales', rupees(stats.sales ?? stats.revenue), 'All orders except cancelled'],
    ['Received', rupees(stats.revenue), 'Marked paid'],
    ['Orders', stats.orders, `${stats.completed} completed`],
    ['Average order', rupees(stats.avg_order ?? 0), 'Per non-cancelled order'],
    ['Cancelled', stats.cancelled, stats.orders ? `${Math.round((stats.cancelled / stats.orders) * 100)}% of orders` : '—'],
  ];
  const cards = `<div class="adm-kpis">${kpis.map(([title, value, note]) => `<div class="adm-kpi"><small>${e(title)}</small><strong>${e(value)}</strong><span>${e(note)}</span></div>`).join('')}</div>`;
  if (!stats.daily) {
    $('reportBody').innerHTML = cards + '<p class="adm-muted">Charts appear once the latest server update is installed.</p>';
    return;
  }
  const hourly = new Map(stats.hourly.map(row => [row.hour, row]));
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: Number(hourly.get(hour)?.orders || 0), sales: Number(hourly.get(hour)?.sales || 0) }));
  const daily = new Map(stats.daily.map(row => [row.day, row]));
  const days = dayList(start, state.reportDays).map(day => ({ day, orders: Number(daily.get(day)?.orders || 0), sales: Number(daily.get(day)?.sales || 0) }));
  const dayLabel = day => new Date(day + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  const salesPoints = today
    ? hours.map(h => ({ label: hourName(h.hour), value: h.sales, tip: `${hourName(h.hour)} · ${rupees(h.sales)} · ${h.orders} orders` }))
    : days.map(d => ({ label: dayLabel(d.day), short: new Date(d.day + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric' }), value: d.sales, tip: `${dayLabel(d.day)} · ${rupees(d.sales)} · ${d.orders} orders` }));
  const busiest = hours.reduce((best, h) => h.orders > best.orders ? h : best, hours[0]);
  const typeNames = { delivery: 'Delivery', takeaway: 'Takeaway', dine_in: 'Dine in' };
  const payNames = { cod: 'Cash on delivery', cash: 'Cash', upi: 'UPI', whatsapp: 'WhatsApp', razorpay: 'Online' };
  $('reportBody').innerHTML = `${cards}
    <section class="adm-card adm-chart-card adm-chart-wide">
      <header><h3>${today ? 'Sales by hour today' : `Sales per day · last ${state.reportDays} days`}</h3><span class="adm-muted">Excludes cancelled orders</span></header>
      ${columnChart({ points: salesPoints, format: rupees, axisFormat: compactRupees, title: today ? 'Sales by hour' : 'Sales per day', width: full })}
      ${tableView([today ? 'Hour' : 'Day', 'Orders', 'Sales'], today ? hours.filter(h => h.orders).map(h => [hourName(h.hour), h.orders, rupees(h.sales)]) : days.map(d => [dayLabel(d.day), d.orders, rupees(d.sales)]))}
    </section>
    <section class="adm-card adm-chart-card">
      <header><h3>Busiest hours</h3><span class="adm-muted">${busiest.orders ? `Peak ${hourName(busiest.hour)} · ${busiest.orders} orders` : 'No orders yet'}</span></header>
      ${columnChart({ points: hours.map(h => ({ label: hourName(h.hour), value: h.orders, tip: `${hourName(h.hour)} · ${h.orders} orders` })), format: value => `${value}`, axisFormat: value => `${Math.round(value)}`, title: 'Orders by hour of day', width: half })}
    </section>
    <section class="adm-card adm-chart-card">
      <header><h3>Top dishes</h3><span class="adm-muted">Portions sold</span></header>
      ${stats.top_items.length ? barList(stats.top_items.map(item => ({ label: item.name, value: Number(item.quantity) })), value => `${value}`) : '<p class="adm-empty">No orders in this period.</p>'}
    </section>
    <section class="adm-card adm-chart-card">
      <header><h3>Order types</h3><span class="adm-muted">Orders · sales</span></header>
      ${stats.by_type.length ? barList(stats.by_type.map(row => ({ label: typeNames[row.key] || row.key, value: Number(row.orders), tip: `${typeNames[row.key] || row.key}: ${row.orders} orders · ${rupees(row.sales)}` })), value => `${value}`) : '<p class="adm-empty">No orders in this period.</p>'}
    </section>
    <section class="adm-card adm-chart-card">
      <header><h3>Payment methods</h3><span class="adm-muted">Orders · sales</span></header>
      ${stats.by_payment.length ? barList(stats.by_payment.map(row => ({ label: payNames[row.key] || row.key, value: Number(row.orders), tip: `${payNames[row.key] || row.key}: ${row.orders} orders · ${rupees(row.sales)}` })), value => `${value}`) : '<p class="adm-empty">No orders in this period.</p>'}
    </section>
    <p class="adm-muted adm-chart-wide">Days and hours follow India time. "Received" counts orders marked paid.</p>`;
}

// One floating tooltip for every chart mark.
(() => {
  const tip = document.createElement('div');
  tip.className = 'adm-tooltip';
  tip.hidden = true;
  document.body.append(tip);
  const body = $('reportBody');
  body.addEventListener('pointermove', event => {
    const target = event.target.closest('[data-tip]');
    body.querySelectorAll('.is-hover').forEach(node => node !== target && node.classList.remove('is-hover'));
    if (!target) { tip.hidden = true; return; }
    target.classList.add('is-hover');
    tip.textContent = target.dataset.tip;
    tip.hidden = false;
    const x = Math.min(event.clientX + 14, innerWidth - tip.offsetWidth - 8), y = Math.max(8, event.clientY - tip.offsetHeight - 12);
    tip.style.transform = `translate(${x}px, ${y}px)`;
  });
  body.addEventListener('pointerleave', () => { tip.hidden = true; body.querySelectorAll('.is-hover').forEach(node => node.classList.remove('is-hover')); });
})();

// ---------- billing ----------
const BILLING_FIELDS = ['legal_name', 'address', 'phone', 'gstin', 'fssai', 'prefix', 'sac', 'footer'];
const invoiceLink = orderId => `invoice.html?order=${encodeURIComponent(orderId)}`;

async function loadBillingSettings(version) {
  try {
    const { settings } = await api('billing_settings');
    if (version !== authVersion) return;
    state.billing = settings;
    fillBillingForm(settings);
  } catch {
    // The billing server update isn't installed yet: hide its screens rather than showing errors.
    if (version !== authVersion) return;
    state.billing = null;
  }
  const available = Boolean(state.billing);
  document.querySelector('#adminNav [data-section="billing"]').hidden = !available || !can('billing');
  $('billingSettingsCard').hidden = !available;
  if (!available && state.section === 'billing') location.hash = '#orders';
  else if (state.section === 'billing') refreshBilling().catch(error => toast(error.message, 'error'));
}

function fillBillingForm(settings) {
  const form = $('billingForm');
  BILLING_FIELDS.forEach(name => { form.elements[name].value = settings[name] ?? ''; });
  $('billingSwitch').setAttribute('aria-checked', String(Boolean(settings.enabled)));
  $('counterNotice').hidden = Boolean(settings.enabled);
  syncBillingHints();
}

function syncBillingHints() {
  const form = $('billingForm');
  const gstin = form.elements.gstin.value.trim().toUpperCase();
  const supply = placeOfSupply(gstin);
  $('gstinHelp').textContent = gstin && !GSTIN.test(gstin) ? 'A GSTIN is 15 characters, e.g. 32ABCDE1234F1Z5.'
    : gstin ? `Documents print as "Tax invoice"${supply ? `, place of supply ${supply}` : ''}.`
    : 'Without a GSTIN, documents print as "Bill", not "Tax invoice". Orders still add 5% GST, so check your GST registration with your accountant.';
  const prefix = form.elements.prefix.value.trim().toUpperCase() || 'NF', year = financialYear(todayIST());
  $('prefixPreview').textContent = `Numbers look like ${prefix}/${year}/00001 for invoices and ${prefix}C/${year}/00001 for credit notes.`;
}
$('billingForm').addEventListener('input', syncBillingHints);

function billingError(message) {
  $('billingError').textContent = message;
  $('billingError').hidden = !message;
}

async function saveBilling(enabled) {
  billingError('');
  const values = Object.fromEntries(BILLING_FIELDS.map(name => [name, $('billingForm').elements[name].value]));
  let settings;
  try { settings = normalizeBillingSettings({ ...values, enabled }); } catch (error) { billingError(error.message); throw error; }
  try {
    const result = await api('set_billing_settings', { settings });
    state.billing = result.settings;
    fillBillingForm(result.settings);
    return result.settings;
  } catch (error) { billingError(error.message); throw error; }
}

$('billingForm').onsubmit = event => {
  event.preventDefault();
  run(async () => { await saveBilling(state.billing?.enabled === true); toast('Business details saved', 'success'); })({ currentTarget: $('billingSave') });
};

$('billingSwitch').onclick = run(async () => {
  const enabled = $('billingSwitch').getAttribute('aria-checked') !== 'true';
  const choice = await ask(enabled
    ? { title: 'Start issuing invoices?', message: 'From now on, every order that is completed and paid gets the next invoice number. Issued invoices are permanent.', choices: [{ label: 'Turn on invoicing', value: 'yes' }, { label: 'Not yet', value: null }] }
    : { title: 'Stop issuing invoices?', message: "Orders finished while invoicing is off won't get an invoice automatically. You can still issue one later from the order.", choices: [{ label: 'Turn off invoicing', value: 'yes', tone: 'danger' }, { label: 'Keep invoicing on', value: null }] });
  if (!choice) return;
  const saved = await saveBilling(enabled);
  toast(saved.enabled ? 'Invoicing is on' : 'Invoicing is off', 'success');
});

function applyBillPreset(preset) {
  const { from, to } = billingRange(preset, todayIST());
  $('billFrom').value = from; $('billTo').value = to;
  document.querySelectorAll('#billRange [data-preset]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.preset === preset)));
}
document.querySelectorAll('#billRange [data-preset]').forEach(button => button.onclick = () => {
  applyBillPreset(button.dataset.preset);
  state.billPage = 0;
  refreshBilling().catch(error => toast(error.message, 'error'));
});
// Editing the dates by hand means no preset is selected any more.
['billFrom', 'billTo'].forEach(id => $(id).addEventListener('change', () => document.querySelectorAll('#billRange [data-preset]').forEach(button => button.setAttribute('aria-selected', 'false'))));
$('billingFilters').onsubmit = event => { event.preventDefault(); state.billPage = 0; refreshBilling().catch(error => toast(error.message, 'error')); };
$('billPrev').onclick = run(async () => { state.billPage = Math.max(0, state.billPage - 1); await refreshBilling(); });
$('billNext').onclick = run(async () => { state.billPage++; await refreshBilling(); });

function billingQuery() {
  if (!$('billFrom').value || !$('billTo').value) applyBillPreset('month');
  const from = $('billFrom').value, to = $('billTo').value;
  if (from > to) throw new Error('"From" must be on or before "To".');
  return { start: indiaDayRange(from).start, end: indiaDayRange(to).end, search: $('billSearch').value.trim(), from, to };
}

function invoiceRow(invoice) {
  const credited = creditedTotal(invoice);
  const badge = needsCreditNote(invoice) ? '<span class="adm-badge adm-badge-cancelled">Refunded · needs credit note</span>'
    : credited ? `<span class="adm-badge">Credited ${e(rupees2(credited))}</span>` : '<span></span>';
  return `<div class="adm-invoice">
    <button type="button" class="adm-row" data-open="${e(invoice.order_id)}"><strong>${e(invoice.invoice_no)}</strong><span>${e(invoice.buyer?.name || 'Walk-in customer')} <small class="adm-muted">· ${e(billDate(invoice.issued_at))}</small></span>${badge}<strong>${e(rupees2(invoice.total))}</strong></button>
    <a class="adm-icon-btn" href="${e(invoiceLink(invoice.order_id))}" target="_blank" rel="noopener" title="Print invoice" aria-label="Print invoice ${e(invoice.invoice_no)}"><i class="fa-solid fa-print"></i></a>
  </div>`;
}

async function refreshBilling() {
  if (!isManager()) return;
  const query = billingQuery();
  const { invoices, count, summary } = await api('invoices', { start: query.start, end: query.end, search: query.search, page: state.billPage });
  const off = !state.billing?.enabled;
  $('billingNotice').hidden = !off;
  $('billingNotice').innerHTML = off ? (state.role === 'admin'
    ? 'Invoicing is off. Fill in your business details and turn it on in <a class="adm-link" href="#settings">Settings</a>.'
    : 'Invoicing is off. An admin can turn it on in Settings.') : '';
  const gst = Number(summary.cgst) + Number(summary.sgst), creditGst = Number(summary.credit_cgst) + Number(summary.credit_sgst);
  const kpis = [
    ['Invoiced', rupees2(summary.total), `${summary.invoices} invoice${summary.invoices === 1 ? '' : 's'}`],
    ['Taxable value', rupees2(summary.taxable), 'Food before GST'],
    ['GST collected', rupees2(gst), `CGST ${rupees2(summary.cgst)} · SGST ${rupees2(summary.sgst)}`],
    ['Credit notes', rupees2(summary.credit_total), `${summary.credit_notes} issued · GST ${rupees2(creditGst)}`],
    ['Net', rupees2(Number(summary.total) - Number(summary.credit_total)), 'Invoiced minus credit notes'],
  ];
  $('billingSummary').innerHTML = kpis.map(([title, value, note]) => `<div class="adm-kpi"><small>${e(title)}</small><strong>${e(value)}</strong><span>${e(note)}</span></div>`).join('');
  $('invoiceList').innerHTML = invoices.map(invoiceRow).join('') || `<p class="adm-empty">${query.search ? 'No invoice number matches in this period.' : 'No invoices in this period.'}</p>`;
  $('billPrev').disabled = state.billPage === 0;
  $('billNext').disabled = (state.billPage + 1) * 30 >= count;
  $('billPage').textContent = `${count} invoice${count === 1 ? '' : 's'} · page ${state.billPage + 1}`;
}

$('billExport').onclick = run(async () => {
  const query = billingQuery();
  const { invoices, count } = await api('invoices', { start: query.start, end: query.end, search: query.search, export: true });
  if (!invoices.length) { toast('No invoices to export in this period.'); return; }
  if (count > invoices.length) toast(`Exported the latest ${invoices.length} of ${count} invoices. Choose a shorter period for the rest.`, 'error');
  // Byte-order mark so Excel opens the file as UTF-8 (customer names aren't always ASCII).
  const url = URL.createObjectURL(new Blob(['﻿' + invoicesCSV(invoices)], { type: 'text/csv;charset=utf-8' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: `invoices-${query.from}-to-${query.to}.csv` });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function invoiceBlock(order, invoice) {
  if (!isManager()) return '';
  if (invoice) return `<section class="adm-detail-block"><h3>Invoice</h3>
    <p><strong>${e(invoice.invoice_no)}</strong></p>
    <div class="adm-head-actions"><a class="adm-btn" href="${e(invoiceLink(order.id))}" target="_blank" rel="noopener"><i class="fa-solid fa-print"></i> Print invoice</a>${state.role === 'admin' ? '<button type="button" class="adm-btn" id="creditBtn"><i class="fa-solid fa-rotate-left"></i> Credit note</button>' : ''}</div></section>`;
  if (!state.billing?.enabled || order.order_status === 'cancelled') return '';
  if (order.order_status === 'completed' && order.payment_status === 'paid') return `<section class="adm-detail-block"><h3>Invoice</h3>
    <p class="adm-muted">This order finished before invoicing was turned on.</p>
    <div><button type="button" class="adm-btn adm-btn-primary" id="issueInvoiceBtn"><i class="fa-solid fa-file-invoice"></i> Issue invoice</button></div></section>`;
  return '<p class="adm-muted adm-invoice-hint"><i class="fa-solid fa-file-invoice"></i> The invoice is issued automatically once this order is completed and paid.</p>';
}

let creditTarget = null;
async function openCreditNote(orderId) {
  const { invoice } = await api('invoice', { id: orderId });
  const credited = creditedTotal(invoice), remaining = Math.round((Number(invoice.total) - credited) * 100) / 100;
  if (remaining <= 0) { toast('This invoice has already been fully credited.'); return; }
  creditTarget = { invoice, remaining, orderId };
  const form = $('creditForm');
  form.reset();
  $('creditTitle').textContent = `Credit note for ${invoice.invoice_no}`;
  $('creditInfo').textContent = `Invoice total ${rupees2(invoice.total)} · already credited ${rupees2(credited)} · up to ${rupees2(remaining)} can be credited.`;
  form.elements.amount.max = remaining.toFixed(2);
  form.elements.amount.value = remaining.toFixed(2);
  $('creditError').hidden = true;
  $('creditDialog').showModal();
  form.elements.reason.focus();
}

$('creditForm').onsubmit = async event => {
  event.preventDefault();
  const button = $('creditSave');
  if (button.disabled || !creditTarget) return;
  const form = event.currentTarget, amount = Number(form.elements.amount.value), reason = form.elements.reason.value.trim();
  const fail = message => { $('creditError').textContent = message; $('creditError').hidden = false; };
  if (!(amount > 0) || amount > creditTarget.remaining) return fail(`Enter an amount from ₹0.01 to ${rupees2(creditTarget.remaining)}.`);
  if (reason.length < 3) return fail('Give a short reason (at least 3 characters).');
  button.disabled = true;
  try {
    await api('credit_note', { invoiceId: creditTarget.invoice.id, amount, reason });
    $('creditDialog').close();
    toast('Credit note issued', 'success');
    if (state.section === 'billing') refreshBilling().catch(error => toast(error.message, 'error'));
  } catch (error) { fail(error.message); }
  finally { button.disabled = false; }
};

// ---------- settings ----------
$('codSwitch').onclick = run(async () => {
  const enabled = $('codSwitch').getAttribute('aria-checked') !== 'true';
  const result = await api('set_cod', { enabled });
  $('codSwitch').setAttribute('aria-checked', String(result.codEnabled));
  toast(result.codEnabled ? 'Cash on delivery turned on' : 'Cash on delivery turned off', 'success');
});

$('deliverySwitch').onclick = run(async () => {
  const enabled = $('deliverySwitch').getAttribute('aria-checked') !== 'true';
  if (!enabled) {
    const choice = await ask({ title: 'Pause home delivery?', message: 'Customers will only be able to order takeaway or dine in until you turn it back on.', choices: [{ label: 'Pause delivery', value: 'yes', tone: 'danger' }, { label: 'Keep delivery on', value: null }] });
    if (!choice) return;
  }
  const result = await api('set_delivery', { enabled });
  $('deliverySwitch').setAttribute('aria-checked', String(result.deliveryEnabled));
  toast(result.deliveryEnabled ? 'Home delivery is on' : 'Home delivery paused', 'success');
});

// ---------- dialogs ----------
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
  // Click on the backdrop closes the drawer.
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
});

const menuAdmin = createMenuAdmin({ supabase, toast, run, isAdmin: () => state.role === 'admin' });
const cashCount = createCashCount({ api, toast, run, ask, todayIST });
const counter = createCounter({ supabase, api, toast, run, ask, billingEnabled: () => state.billing?.enabled === true });

// ---------- boot ----------
if (isSupabaseConfigured) {
  supabase.auth.getSession().then(({ data }) => evaluateSession(data.session));
  supabase.auth.onAuthStateChange((event, session) => {
    // Supabase advises against awaiting inside this callback; token refreshes need no re-check.
    if (event === 'TOKEN_REFRESHED') return;
    setTimeout(() => evaluateSession(session), 0);
  });
} else {
  evaluateSession(null);
}
