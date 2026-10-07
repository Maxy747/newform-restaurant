import { supabase, isSupabaseConfigured } from './supabaseClient.js';
import { createOmsApi } from './oms-client.js';
import { escapeHTML as e, money, statusLabel as label, nextStatuses, indiaDayRange, stepTimes } from './oms-policy.js';
import { BOARD_COLUMNS, groupOrders, findNewOrders, ageLabel, minutesSince } from './admin-policy.js';
import { createMenuAdmin } from './admin-menu.js';

const THEME_KEY = 'newform_theme_v1';
const SOUND_KEY = 'newform_admin_sound_v1';
const ACTIVE_STATUSES = ['new', 'awaiting_payment', 'confirmed', 'preparing', 'ready', 'out_for_delivery'];
const SECTIONS = { orders: ['admin', 'staff', 'kitchen', 'delivery'], menu: ['admin'], tickets: ['admin', 'staff'], reports: ['admin', 'staff'], settings: ['admin'] };
const TYPE_ICON = { delivery: 'fa-motorcycle', takeaway: 'fa-bag-shopping', dine_in: 'fa-chair' };
const TYPE_LABEL = { delivery: 'Delivery', takeaway: 'Takeaway', dine_in: 'Dine in' };
const PAYMENT_LABEL = { cod: 'COD', cash: 'Pay at counter', whatsapp: 'WhatsApp', razorpay: 'Online' };
const typeName = type => TYPE_LABEL[type] || label(type);
const paymentName = method => PAYMENT_LABEL[method] || label(method);

const $ = id => document.getElementById(id);
const api = createOmsApi(supabase, isSupabaseConfigured);
const state = { role: null, config: {}, section: 'orders', ordersView: 'board', historyPage: 0, detailId: null, reportDays: 1 };
const seenOrders = new Set();
let primed = false, arrived = new Set(), lastBoardHTML = '', channel = null, pollTimer = null, refreshTimer = null, boardVersion = 0, detailVersion = 0, authVersion = 0;
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
let soundOn = (() => { try { return localStorage.getItem(SOUND_KEY) === 'on'; } catch { return false; } })();
function syncSoundButton() {
  $('soundBtn').setAttribute('aria-pressed', String(soundOn));
  $('soundBtn').setAttribute('aria-label', soundOn ? 'Turn off new-order sound' : 'Turn on new-order sound');
  $('soundBtn').querySelector('i').className = soundOn ? 'fa-solid fa-volume-high' : 'fa-solid fa-volume-xmark';
}
function unlockAudio() {
  if (!audio) { try { audio = new AudioContext(); } catch { return; } }
  if (audio.state === 'suspended') audio.resume().catch(() => {});
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
  syncSoundButton();
  toast(soundOn ? 'New-order sound on' : 'New-order sound off');
};
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
  navigator.vibrate?.([200, 100, 200]);
  const first = orders[0];
  const summary = orders.length > 1 ? `${orders.length} new orders` : `New ${typeName(first.order_type).toLowerCase()} order ${shortId(first.id)}`;
  toast(summary, 'success');
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const note = new Notification('NEWFORM · ' + summary, { body: orders.map(o => `${shortId(o.id)} · ${money(o.total)}`).join('\n'), icon: 'assets/newform_logo.png', tag: 'newform-new-order' });
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
  state.config = config;
  $('gate').hidden = true;
  $('topActions').hidden = false;
  $('adminNav').hidden = false;
  document.body.dataset.role = state.role;
  document.querySelectorAll('#adminNav [data-section]').forEach(link => { link.hidden = !can(link.dataset.section); });
  // Kitchen and delivery only work the live board.
  document.querySelector('[data-orders-view="history"]').hidden = !isManager();
  $('codSwitch').setAttribute('aria-checked', String(Boolean(config.codEnabled)));
  primed = false; seenOrders.clear();
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
  if (section === 'tickets') refreshTickets().catch(error => toast(error.message, 'error'));
  if (section === 'reports') refreshReports().catch(error => toast(error.message, 'error'));
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

function itemSummary(order) {
  return order.items.map(item => `${item.quantity}× ${item.name}${item.portion && item.portion !== 'single' ? ` (${item.portion})` : ''}`).join(', ');
}

function actionButtons(order, compact = false) {
  return nextStatuses(order, state.role).map(status => {
    const cancel = status === 'cancelled';
    if (compact && cancel) return '';
    return `<button type="button" class="adm-btn ${cancel ? 'adm-btn-danger' : 'adm-btn-primary'}" data-order="${e(order.id)}" data-status="${e(status)}">${cancel ? 'Cancel order' : 'Mark ' + e(label(status).toLowerCase())}</button>`;
  }).join('');
}

function orderCard(order) {
  const waiting = minutesSince(order.created_at);
  const late = ['new', 'confirmed', 'preparing'].includes(order.order_status) && waiting >= 20;
  const payment = order.payment_status === 'paid' ? '<span class="adm-chip adm-chip-ok">Paid</span>' : `<span class="adm-chip">${e(paymentName(order.payment_method))}</span>`;
  return `<article class="adm-order${late ? ' is-late' : ''}${order.order_status === 'new' ? ' is-new' : ''}${arrived.has(order.id) ? ' just-arrived' : ''}" data-open="${e(order.id)}" tabindex="0" aria-label="Order ${e(shortId(order.id))}">
    <header><strong>${e(shortId(order.id))}</strong><span class="adm-age" title="${e(time(order.created_at))}"><i class="fa-regular fa-clock"></i> ${e(ageLabel(order.created_at))}</span></header>
    <div class="adm-order-meta"><span><i class="fa-solid ${TYPE_ICON[order.order_type] || 'fa-receipt'}"></i> ${e(typeName(order.order_type))}${order.table_number ? ' · Table ' + e(order.table_number) : ''}</span>${payment}</div>
    ${order.customer_name ? `<p class="adm-order-name">${e(order.customer_name)}</p>` : ''}
    <p class="adm-order-items">${e(itemSummary(order))}</p>
    <footer><strong>${money(order.total)}</strong>${order.order_status === 'awaiting_payment' ? '<span class="adm-chip">Awaiting payment</span>' : ''}<span class="adm-order-actions">${actionButtons(order, true)}</span></footer>
  </article>`;
}

function finishedRow(order) {
  return `<button type="button" class="adm-row" data-open="${e(order.id)}"><strong>${e(shortId(order.id))}</strong><span>${e(order.customer_name || typeName(order.order_type))}</span><span class="adm-badge adm-badge-${e(order.order_status)}">${e(label(order.order_status))}</span><strong>${money(order.total)}</strong></button>`;
}

async function refreshBoard() {
  const version = ++boardVersion;
  const orders = await fetchBoardOrders();
  if (version !== boardVersion) return;
  const unique = [...new Map(orders.map(order => [order.id, order])).values()];
  const fresh = findNewOrders(seenOrders, unique, primed);
  announce(fresh);
  // Only genuinely new arrivals get the slide-in animation, once.
  arrived = new Set(fresh.map(order => order.id));
  primed = true;
  const { columns, finished } = groupOrders(unique);
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
  if (boardHTML !== lastBoardHTML) { $('orderBoard').innerHTML = boardHTML; lastBoardHTML = boardHTML; }
  $('finishedCount').textContent = `(${finished.length})`;
  $('finishedList').innerHTML = finished.map(finishedRow).join('') || '<p class="adm-empty">No finished orders yet today.</p>';
  $('finishedWrap').hidden = !isManager() && state.role !== 'delivery';
  if (isManager()) await refreshTodayStats(version);
}

async function refreshTodayStats(version) {
  const range = indiaDayRange(todayIST());
  const stats = await api('analytics', { start: range.start, end: range.end });
  if (version !== boardVersion) return;
  $('todayStats').innerHTML = [['Orders today', stats.orders], ['Received', money(stats.revenue)], ['Completed', stats.completed], ['Cancelled', stats.cancelled]]
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
      <strong>${e(shortId(order.id))}</strong><span>${e(time(order.created_at))}</span><span>${e(order.customer_name || '')}</span>
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
  const { order: o, events, tickets } = await api('detail', { id });
  if (version !== detailVersion || id !== state.detailId) return;
  const body = $('orderDialogBody');
  // Keep a half-written ticket reply intact during live refreshes.
  if (body.contains(document.activeElement) && document.activeElement.matches('textarea, input, select')) return;
  if ([...body.querySelectorAll('textarea')].some(field => field.value)) return;
  const steps = ['new', 'confirmed', 'preparing', 'ready', ...(o.order_type === 'delivery' ? ['out_for_delivery'] : []), 'completed'];
  const current = steps.indexOf(o.order_status);
  const reached = stepTimes(events);
  const canCash = state.role !== 'kitchen' && o.payment_method !== 'razorpay' && o.payment_status !== 'paid' && o.order_status !== 'cancelled';
  const deliveryPin = o.delivery_latitude != null && o.delivery_longitude != null ? `https://www.google.com/maps?q=${Number(o.delivery_latitude)},${Number(o.delivery_longitude)}` : null;
  body.innerHTML = `
    <div class="adm-detail-status"><span class="adm-badge adm-badge-${e(o.order_status)}">${e(label(o.order_status))}</span><span class="adm-muted">Placed ${e(time(o.created_at))} · ${e(ageLabel(o.created_at))} ago</span></div>
    ${o.order_status === 'cancelled' ? '' : `<ol class="adm-steps">${steps.map((step, index) => `<li class="${index < current ? 'done' : index === current ? 'current' : ''}"><span>${e(label(step))}</span>${reached.has(step) ? `<small>${e(new Date(reached.get(step)).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }))}</small>` : ''}</li>`).join('')}</ol>`}
    <div class="adm-detail-actions">${actionButtons(o)}${canCash ? '<button type="button" class="adm-btn" id="cashBtn"><i class="fa-solid fa-money-bill-wave"></i> Cash received</button>' : ''}</div>
    <section class="adm-detail-block"><h3>Items</h3>
      <ul class="adm-items">${o.items.map(item => `<li><span>${e(item.quantity)} × ${e(item.name)}${item.portion && item.portion !== 'single' ? ` <small>(${e(item.portion)})</small>` : ''}</span><strong>${money(item.quantity * item.price)}</strong></li>`).join('')}</ul>
      <dl class="adm-totals"><dt>Subtotal</dt><dd>${money(o.subtotal)}</dd><dt>GST</dt><dd>${money(o.tax)}</dd>${o.order_type === 'delivery' ? `<dt>Delivery${o.delivery_distance_m != null ? ` · ${(o.delivery_distance_m / 1000).toFixed(1)} km` : ''}</dt><dd>${money(o.delivery_fee || 0)}</dd>` : ''}<dt class="adm-total">Total</dt><dd class="adm-total">${money(o.total)}</dd></dl>
    </section>
    <section class="adm-detail-block"><h3>${e(typeName(o.order_type))}</h3>
      ${o.customer_name ? `<p><strong>${e(o.customer_name)}</strong></p>` : ''}
      ${o.phone ? `<p><a class="adm-link" href="tel:${e(o.phone.replace(/[^0-9+]/g, ''))}"><i class="fa-solid fa-phone"></i> ${e(o.phone)}</a></p>` : ''}
      ${o.table_number ? `<p>Table ${e(o.table_number)}</p>` : ''}
      ${o.delivery_address ? `<p class="adm-pre">${e(o.delivery_address)}</p>` : ''}
      ${deliveryPin ? `<p><a class="adm-link" href="${e(deliveryPin)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-location-dot"></i> Open delivery pin in Maps</a></p>` : ''}
      <p class="adm-muted">Payment: ${e(o.payment_method === 'cod' ? 'Cash on delivery' : paymentName(o.payment_method))} · ${e(label(o.payment_status))}</p>
    </section>
    <details class="adm-detail-block"><summary>Activity (${events.length})</summary><ul class="adm-events">${events.map(event => `<li><small>${e(time(event.created_at))}</small> ${e(label(event.detail))}</li>`).join('')}</ul></details>
    <div id="orderTickets"></div>`;
  body.querySelectorAll('[data-status]').forEach(button => button.onclick = run(() => changeStatus(button.dataset.order, button.dataset.status)));
  if ($('cashBtn')) $('cashBtn').onclick = run(async () => {
    if (!confirm(`Confirm you received ${money(o.total)} for ${shortId(o.id)}?`)) return;
    await api('cash', { id: o.id });
    toast('Payment marked as received', 'success');
    await refreshDetail(); queueRefresh(0);
  });
  if (isManager()) renderTickets(o, tickets);
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

async function changeStatus(id, status) {
  if (status === 'cancelled' && !confirm(`Cancel order ${shortId(id)}? The customer will see it as cancelled.`)) return;
  await api('transition', { id, status });
  toast(`${shortId(id)} → ${label(status)}`, 'success');
  queueRefresh(0);
  if (state.detailId === id && $('orderDialog').open) await refreshDetail();
}

$('orderDialog').addEventListener('close', () => { state.detailId = null; detailVersion++; });

// One delegated handler for every order card/row in the page.
document.addEventListener('click', event => {
  const action = event.target.closest('[data-status]');
  if (action && !action.closest('#orderDialog')) { event.stopPropagation(); run(() => changeStatus(action.dataset.order, action.dataset.status))({ currentTarget: action }); return; }
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

// ---------- reports ----------
document.querySelectorAll('#reportRange [data-range]').forEach(button => button.onclick = () => {
  state.reportDays = Number(button.dataset.range);
  document.querySelectorAll('#reportRange [data-range]').forEach(other => other.setAttribute('aria-selected', String(other === button)));
  refreshReports().catch(error => toast(error.message, 'error'));
});
async function refreshReports() {
  if (!isManager()) return;
  const end = indiaDayRange(todayIST()).end;
  const start = new Date(Date.parse(end) - state.reportDays * 86400000).toISOString();
  const stats = await api('analytics', { start, end });
  const max = Math.max(1, ...stats.top_items.map(item => item.quantity));
  $('reportBody').innerHTML = `<div class="adm-stat-row">${[['Orders', stats.orders], ['Received', money(stats.revenue)], ['Completed', stats.completed], ['Cancelled', stats.cancelled], ['In progress', Number(stats.new) + Number(stats.preparing) + Number(stats.ready)]]
      .map(([title, value]) => `<div class="adm-stat"><small>${e(title)}</small><strong>${e(value)}</strong></div>`).join('')}</div>
    <div class="adm-card"><h3>Top dishes</h3>${stats.top_items.length ? `<ul class="adm-bars">${stats.top_items.map(item => `<li><span>${e(item.name)}</span><span class="adm-bar"><i style="width:${(item.quantity / max) * 100}%"></i></span><strong>${e(item.quantity)}</strong></li>`).join('')}</ul>` : '<p class="adm-empty">No orders in this period.</p>'}</div>
    <p class="adm-muted">"Received" counts orders marked paid. Days follow India time.</p>`;
}

// ---------- settings ----------
$('codSwitch').onclick = run(async () => {
  const enabled = $('codSwitch').getAttribute('aria-checked') !== 'true';
  const result = await api('set_cod', { enabled });
  $('codSwitch').setAttribute('aria-checked', String(result.codEnabled));
  toast(result.codEnabled ? 'Cash on delivery turned on' : 'Cash on delivery turned off', 'success');
});

// ---------- dialogs ----------
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
  // Click on the backdrop closes the drawer.
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
});

const menuAdmin = createMenuAdmin({ supabase, toast, run, isAdmin: () => state.role === 'admin' });

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
