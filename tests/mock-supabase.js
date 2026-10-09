// Local-only fake Supabase backend for visual checks: `npx vite --mode mock`.
// Never bundled in production builds (see vite.config.js). No network calls.
import { financialYear } from '../billing.js';
const role = () => { try { return localStorage.getItem('mock_role') || 'admin'; } catch { return 'admin'; } };
const signedIn = () => { try { return localStorage.getItem('mock_signed_out') !== '1'; } catch { return true; } };
const now = Date.now();
const iso = minutesAgo => new Date(now - minutesAgo * 60000).toISOString();
const uuid = n => `${String(n).padStart(8, '0')}-4b7f-4c2a-9d4e-0000000000${String(n).padStart(2, '0')}`;
const line = (name, quantity, price, portion = 'single') => ({ name, quantity, price, portion });
const mk = (n, status, minutesAgo, type, items, extra = {}) => {
  const subtotal = items.reduce((sum, item) => sum + item.quantity * item.price, 0), tax = Math.round(subtotal * 5) / 100;
  const delivery_fee = type === 'delivery' ? 68 : 0;
  return { id: uuid(n), daily_number: n < 100 ? n : null, order_status: status, order_type: type, created_at: iso(minutesAgo), updated_at: iso(Math.max(0, minutesAgo - 3)), items, subtotal, tax, delivery_fee, total: subtotal + tax + delivery_fee,
    customer_name: ['Anjali R', 'Faisal K', 'Meera S', 'Rahul P', 'Shabeer M', 'Nisha T'][n % 6], phone: '+91 98470 1' + String(1000 + n).slice(-4),
    delivery_address: type === 'delivery' ? 'Green Villa, Near Bus Stand\nKalpetta, Wayanad' : null, table_number: type === 'dine_in' ? String(n % 9 + 1) : null,
    delivery_latitude: type === 'delivery' ? 11.61 : null, delivery_longitude: type === 'delivery' ? 76.08 : null, delivery_distance_m: type === 'delivery' ? 3400 : null,
    payment_method: type === 'delivery' ? 'cod' : 'cash', payment_status: 'pending', ...extra };
};
let orders = [
  mk(1, 'new', 2, 'delivery', [line('Chicken Mandhi', 2, 260, 'quarter'), line('Lime Juice', 2, 40)]),
  mk(2, 'new', 6, 'takeaway', [line('Alfaham Chicken', 1, 248, 'half')]),
  mk(3, 'confirmed', 11, 'dine_in', [line('Beef Fry', 1, 180), line('Porotta', 4, 15)]),
  mk(4, 'preparing', 24, 'delivery', [line('Pothinkal Mandhi (2 Persons)', 1, 900)], { payment_method: 'whatsapp' }),
  mk(5, 'ready', 31, 'takeaway', [line('Paneer Butter Masala', 1, 220), line('Butter Naan', 3, 35)]),
  mk(6, 'out_for_delivery', 42, 'delivery', [line('Shawaya Chicken Mandhi', 1, 260, 'quarter')], { assigned_driver: 'd2' }),
  mk(9, 'ready', 18, 'delivery', [line('Chicken Mandhi', 1, 480, 'half'), line('Lime Juice', 1, 40)]),
  mk(10, 'ready', 14, 'delivery', [line('Beef Fry', 2, 180), line('Porotta', 6, 15)], { assigned_driver: 'u1' }),
  mk(7, 'completed', 95, 'dine_in', [line('Chicken Biriyani', 2, 160)], { payment_status: 'paid' }),
  mk(8, 'cancelled', 120, 'delivery', [line('Prawns Varattu', 1, 300)]),
];
// Older completed orders so 7/30-day reports have shape.
for (let day = 1; day <= 29; day++) for (let k = 0; k < 2 + (day * 7) % 5; k++) {
  const n = 100 + day * 10 + k, type = ['delivery', 'takeaway', 'dine_in'][(day + k) % 3];
  orders.push(mk(n, day % 9 === 0 && k === 0 ? 'cancelled' : 'completed', day * 1440 + ((k * 137 + day * 53) % 600) - 200, type, [line(['Chicken Mandhi', 'Alfaham Chicken', 'Beef Fry', 'Porotta'][(day + k) % 4], 1 + k % 3, [260, 248, 180, 15][(day + k) % 4])], { payment_status: 'paid' }));
}
// Mock signed-in user is always 'u1'; as the delivery role they are the driver "You (mock)".
let drivers = [
  { id: 'u1', name: 'Arun (you)', email: 'delivery@newform.test', phone: '+91 98470 22222', active: true, on_shift: true },
  { id: 'd2', name: 'Ravi', email: 'ravi@newform.test', phone: '+91 98470 33333', active: true, on_shift: true },
  { id: 'd3', name: 'Sameer', email: 'sameer@newform.test', phone: null, active: true, on_shift: false },
  { id: 'd4', name: 'Old driver', email: 'old@newform.test', phone: null, active: false, on_shift: false },
];
const withDriver = order => { const d = drivers.find(x => x.id === order.assigned_driver); return { ...order, driver: d ? { display_name: d.name, phone: d.phone } : null }; };
const events = {};
orders.forEach(order => { events[order.id] = [{ id: 1, event_type: 'order.created', detail: 'Order placed', created_at: order.created_at }]; });
let tickets = [{ id: uuid(90), order_id: uuid(4), subject: 'Can you add extra mayo?', status: 'open', created_at: iso(20), updated_at: iso(20), ticket_messages: [{ id: 1, author_role: 'customer', message: 'Please add extra mayonnaise and no onions.', created_at: iso(20) }] }];
let codEnabled = true, deliveryEnabled = (() => { try { return localStorage.getItem('mock_delivery') !== 'off'; } catch { return true; } })(), counter = 50;
const listeners = new Set();
const signal = () => listeners.forEach(fn => setTimeout(fn, 50));
// Billing: invoices for completed, paid orders, numbered per financial year like the database does.
let billing = { enabled: true, legal_name: 'Newform Multi Cuisine Restaurant', address: 'Kuttikunnu Rd, Mandayapuram\nKalpetta, Wayanad, Kerala 673121', phone: '7593 881 112', gstin: '32ABCDE1234F1Z5', fssai: '11223344556677', sac: '996331', prefix: 'NF', footer: 'Thank you for dining with us!' };
const invoices = [], counters = {};
const fyOf = at => financialYear(new Date(Date.parse(at) + 5.5 * 3600000).toISOString().slice(0, 10));
const nextNo = (series, at) => { const key = series + fyOf(at); counters[key] = (counters[key] || 0) + 1; return counters[key]; };
function issueInvoice(order, at = new Date().toISOString()) {
  const existing = invoices.find(i => i.order_id === order.id);
  if (existing || !billing.enabled) return existing;
  const n = nextNo('INV', at), half = Math.round(order.subtotal * 2.5) / 100;
  const invoice = { id: 'inv-' + order.id, order_id: order.id, invoice_no: `${billing.prefix}/${fyOf(at)}/${String(n).padStart(5, '0')}`, financial_year: fyOf(at), issued_at: at,
    seller: { ...billing }, buyer: { name: order.customer_name, phone: order.phone, address: order.delivery_address, table: order.table_number, order_type: order.order_type },
    lines: order.items, payment_method: order.payment_method, taxable: order.subtotal, cgst: half, sgst: half, delivery_fee: order.delivery_fee,
    round_off: Math.round((order.total - order.subtotal - 2 * half - order.delivery_fee) * 100) / 100, total: order.total, credit_notes: [] };
  invoices.push(invoice); return invoice;
}
[...orders].filter(o => o.order_status === 'completed' && o.payment_status === 'paid').sort((a, b) => a.created_at.localeCompare(b.created_at))
  .forEach(o => issueInvoice(o, new Date(Date.parse(o.created_at) + 40 * 60000).toISOString()));
orders.find(o => o.id === uuid(7)).payment_status = 'refunded'; // shows the "needs credit note" state
const invoiceView = i => ({ ...i, order: { payment_status: orders.find(o => o.id === i.order_id)?.payment_status } });
const sum = (rows, key) => Math.round(rows.reduce((total, row) => total + Number(row[key]), 0) * 100) / 100;
const kitchenRedact = order => { const { phone, delivery_address, customer_name, delivery_latitude, delivery_longitude, ...rest } = order; return rest; };

async function oms(body) {
  const r = role();
  const view = order => r === 'kitchen' ? kitchenRedact(withDriver(order)) : withDriver(order);
  switch (body.action) {
    case 'config': return { role: signedIn() ? r : 'customer', codEnabled, deliveryEnabled, payments: false, testMode: true, deliveryRouting: true };
    case 'set_cod': codEnabled = body.enabled; return { codEnabled };
    case 'set_delivery': deliveryEnabled = body.enabled; try { localStorage.setItem('mock_delivery', body.enabled ? 'on' : 'off'); } catch { /* ignore */ } return { deliveryEnabled };
    case 'list': {
      let rows = [...orders].sort((a, b) => b.created_at.localeCompare(a.created_at));
      const mode = r === 'kitchen' ? 'kitchen' : r === 'delivery' ? 'delivery' : body.mode;
      if (mode === 'kitchen') rows = rows.filter(o => ['new', 'confirmed', 'preparing', 'ready'].includes(o.order_status));
      if (mode === 'delivery') rows = rows.filter(o => o.order_type === 'delivery' && ['ready', 'out_for_delivery', 'completed'].includes(o.order_status));
      if (r === 'delivery') rows = rows.filter(o => o.assigned_driver === 'u1' || (!o.assigned_driver && o.order_status === 'ready'));
      if (body.status) rows = rows.filter(o => o.order_status === body.status);
      if (body.type) rows = rows.filter(o => o.order_type === body.type);
      if (body.start) rows = rows.filter(o => o.created_at >= body.start);
      if (body.end) rows = rows.filter(o => o.created_at < body.end);
      if (body.search) rows = rows.filter(o => o.id === body.search || (o.customer_name || '').toLowerCase().includes(body.search.toLowerCase()));
      const page = body.page || 0;
      return { orders: rows.slice(page * 30, page * 30 + 30).map(view), count: rows.length };
    }
    case 'analytics': {
      const rows = orders.filter(o => o.created_at >= body.start && o.created_at < body.end);
      const count = s => rows.filter(o => o.order_status === s).length;
      const top = {};
      rows.filter(o => o.order_status !== 'cancelled').forEach(o => o.items.forEach(i => { top[i.name] = (top[i.name] || 0) + i.quantity; }));
      const live = rows.filter(o => o.order_status !== 'cancelled');
      const ist = o => new Date(Date.parse(o.created_at) + 5.5 * 3600000);
      const group = key => Object.values(live.reduce((acc, o) => { const k = key(o); acc[k] ??= { key: k, orders: 0, sales: 0 }; acc[k].orders++; acc[k].sales += o.total; return acc; }, {}));
      const sales = live.reduce((s, o) => s + o.total, 0);
      return { orders: rows.length, revenue: rows.filter(o => o.payment_status === 'paid').reduce((s, o) => s + o.total, 0), sales, avg_order: live.length ? Math.round(sales / live.length * 100) / 100 : 0,
        new: count('new'), preparing: count('preparing'), ready: count('ready'), completed: count('completed'), cancelled: count('cancelled'),
        top_items: Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, quantity]) => ({ name, quantity })),
        daily: group(o => ist(o).toISOString().slice(0, 10)).map(g => ({ day: g.key, orders: g.orders, sales: g.sales })),
        hourly: group(o => ist(o).getUTCHours()).map(g => ({ hour: Number(g.key), orders: g.orders, sales: g.sales })),
        by_type: group(o => o.order_type).sort((a, b) => b.orders - a.orders), by_payment: group(o => o.payment_method).sort((a, b) => b.orders - a.orders) };
    }
    case 'drivers': {
      if (r === 'delivery') return { drivers: drivers.filter(d => d.id === 'u1').map(({ id, name, phone, active, on_shift }) => ({ id, name, phone, active, on_shift })) };
      return { drivers: drivers.map(d => ({ ...d, active_orders: orders.filter(o => o.assigned_driver === d.id && ['ready', 'out_for_delivery'].includes(o.order_status)).length,
        delivered: orders.filter(o => o.assigned_driver === d.id && o.order_status === 'completed').length + (d.id === 'd2' ? 4 : 0), cash: d.id === 'd2' ? 2140 : 0 })) };
    }
    case 'driver_save': {
      if (!body.name) throw new Error("Enter the driver's name (up to 60 characters)");
      if (body.driverId) { Object.assign(drivers.find(d => d.id === body.driverId), { name: body.name, phone: body.phone || null }); return { id: body.driverId }; }
      if (!body.email.includes('@')) throw new Error('Enter the email the driver signed up with');
      if (body.email.startsWith('nobody')) throw new Error('No account uses that email. Ask the driver to sign up on the website first, then add them here.');
      const id = 'd' + (drivers.length + 1); drivers.push({ id, name: body.name, email: body.email.toLowerCase(), phone: body.phone || null, active: true, on_shift: false }); return { id };
    }
    case 'driver_status': {
      const d = drivers.find(x => x.id === body.driverId);
      if (body.active === false && orders.some(o => o.assigned_driver === d.id && !['completed', 'cancelled'].includes(o.order_status))) throw new Error("Reassign this driver's active deliveries first");
      if (typeof body.active === 'boolean') { d.active = body.active; if (!d.active) d.on_shift = false; }
      if (typeof body.onShift === 'boolean') d.on_shift = body.onShift;
      return { ok: true };
    }
    case 'assign': {
      const order = orders.find(o => o.id === body.id);
      if (r === 'delivery' && body.driver && order.assigned_driver) throw new Error('Another driver already took this order');
      order.assigned_driver = body.driver || null;
      const d = drivers.find(x => x.id === body.driver);
      events[order.id].push({ id: events[order.id].length + 1, event_type: body.driver ? 'driver.assigned' : 'driver.unassigned', detail: body.driver ? (r === 'delivery' ? `${d.name} took this delivery` : `Assigned to ${d.name}`) : 'Driver removed', created_at: new Date().toISOString() });
      signal(); return { ok: true };
    }
    case 'billing_settings': return { settings: billing };
    case 'set_billing_settings': billing = { ...body.settings }; return { settings: billing };
    case 'invoices': {
      let rows = invoices.filter(i => i.issued_at >= body.start && i.issued_at < body.end).sort((a, b) => b.issued_at.localeCompare(a.issued_at));
      if (body.search) rows = rows.filter(i => i.invoice_no.includes(body.search));
      const notes = invoices.flatMap(i => i.credit_notes).filter(n => n.issued_at >= body.start && n.issued_at < body.end);
      const inRange = invoices.filter(i => i.issued_at >= body.start && i.issued_at < body.end);
      const summary = { invoices: inRange.length, taxable: sum(inRange, 'taxable'), cgst: sum(inRange, 'cgst'), sgst: sum(inRange, 'sgst'), delivery: sum(inRange, 'delivery_fee'), round_off: sum(inRange, 'round_off'), total: sum(inRange, 'total'),
        credit_notes: notes.length, credit_taxable: sum(notes, 'taxable'), credit_cgst: sum(notes, 'cgst'), credit_sgst: sum(notes, 'sgst'), credit_total: sum(notes, 'total') };
      const size = body.export ? 5000 : 30, page = body.export ? 0 : body.page || 0;
      return { invoices: rows.slice(page * size, page * size + size).map(invoiceView), count: rows.length, summary };
    }
    case 'invoice': {
      const invoice = invoices.find(i => i.order_id === body.id);
      if (!invoice) throw new Error('No invoice has been issued for this order yet');
      return { invoice };
    }
    case 'counter_order': {
      const c = body.customer || {};
      if (!['cash', 'upi'].includes(body.method)) throw new Error('Choose cash or UPI');
      if (c.order_type === 'dine_in' && !c.table) throw new Error('Enter a table number');
      const priced = body.items.map(line => {
        const item = menu.find(m => m.id === line.id);
        if (!item || item.available === false) throw new Error('An item is unavailable. Please refresh your menu');
        const prices = typeof item.pricesJSON === 'string' ? JSON.parse(item.pricesJSON) : item.pricesJSON;
        return { id: item.id, name: item.name, quantity: line.quantity, portion: line.portion, price: line.portion === 'single' ? item.price : prices[line.portion] };
      });
      const order = mk(++counter, 'confirmed', 0, c.order_type, priced, { payment_method: body.method, payment_status: 'paid', source: 'counter', customer_name: c.name || 'Walk-in customer', phone: c.phone || '', table_number: c.table || null });
      order.daily_number = counter - 40; order.tax = Math.round(order.subtotal * 0.05); order.total = order.subtotal + order.tax;
      orders.push(order);
      events[order.id] = [{ id: 1, event_type: 'order.created', detail: 'Order placed', created_at: order.created_at }, { id: 2, event_type: 'payment.updated', detail: `Paid at counter (${body.method === 'upi' ? 'UPI' : 'cash'})`, created_at: order.created_at }];
      const invoice = issueInvoice(order);
      signal(); return { order: view(order), invoice: invoice ? { id: invoice.id, invoice_no: invoice.invoice_no } : null };
    }
    case 'issue_invoice': {
      const invoice = issueInvoice(orders.find(o => o.id === body.id));
      if (!invoice) throw new Error('Invoicing is turned off. An admin can turn it on in Settings → Invoices.');
      return { id: invoice.id };
    }
    case 'credit_note': {
      const invoice = invoices.find(i => i.id === body.invoiceId), remaining = invoice.total - sum(invoice.credit_notes, 'total');
      if (body.amount > remaining + 0.001) throw new Error(`Credit amount must be between ₹0.01 and ₹${remaining}`);
      const at = new Date().toISOString(), share = key => Math.round(invoice[key] * body.amount / invoice.total * 100) / 100;
      const note = { id: 'cn-' + Date.now(), note_no: `${billing.prefix}C/${fyOf(at)}/${String(nextNo('CN', at)).padStart(5, '0')}`, issued_at: at, reason: body.reason, taxable: share('taxable'), cgst: share('cgst'), sgst: share('sgst'), total: body.amount };
      note.other = Math.round((note.total - note.taxable - note.cgst - note.sgst) * 100) / 100;
      invoice.credit_notes.push(note); signal(); return { id: note.id };
    }
    case 'ticket_list': return { tickets: tickets.filter(t => t.status !== 'resolved') };
    case 'detail': {
      const order = orders.find(o => o.id === body.id);
      if (!order) throw new Error('Order not found or access denied');
      const invoice = r === 'kitchen' || r === 'delivery' ? null : invoices.find(i => i.order_id === order.id);
      return { order: view(order), events: events[order.id] || [], tickets: tickets.filter(t => t.order_id === order.id), invoice: invoice ? { id: invoice.id, invoice_no: invoice.invoice_no } : null };
    }
    case 'transition': {
      const order = orders.find(o => o.id === body.id);
      order.order_status = body.status; order.updated_at = new Date().toISOString();
      events[order.id].push({ id: events[order.id].length + 1, event_type: 'order.' + body.status, detail: body.status, created_at: order.updated_at });
      if (order.order_status === 'completed' && order.payment_status === 'paid') issueInvoice(order);
      signal(); return { ok: true };
    }
    case 'cash': {
      const order = orders.find(o => o.id === body.id);
      order.payment_status = 'paid';
      events[order.id].push({ id: 99, event_type: 'payment.updated', detail: 'Cash payment received', created_at: new Date().toISOString() });
      if (order.order_status === 'completed') issueInvoice(order);
      signal(); return { ok: true };
    }
    case 'ticket': {
      const ticket = tickets.find(t => t.id === body.ticketId);
      if (ticket) { ticket.ticket_messages.push({ id: Date.now(), author_role: r === 'customer' ? 'customer' : r, message: body.message, created_at: new Date().toISOString() }); if (body.status) ticket.status = body.status; }
      return { ticket: ticket?.id };
    }
    default: throw new Error('Mock: unsupported action ' + body.action);
  }
}

let menu = [
  { id: 'm1', name: 'Chicken Mandhi', category: 'mandhi', diet: 'non-veg', tag: 'Chef Special', description: 'Authentic Mandhi chicken.', image: 'assets/mandhi.png', portionType: 'multi', pricesJSON: '{"quarter":260,"half":480,"full":900}', available: true },
  { id: 'a1', name: 'Alfaham Chicken', category: 'broast_alfaham', diet: 'non-veg', tag: 'Bestseller', description: 'Charcoal grilled.', image: 'assets/alfaham.png', portionType: 'multi', pricesJSON: { quarter: 248, half: 460, full: 880 }, available: true },
  { id: 'b1', name: 'Beef Fry', category: 'beef', diet: 'non-veg', tag: null, description: 'Kerala style.', image: 'assets/beeffry.png', portionType: 'single', price: 180, available: false },
  { id: 'v1', name: 'Paneer Butter Masala', category: 'veg', diet: 'veg', tag: null, description: 'Creamy.', image: 'assets/hero.png', portionType: 'single', price: 220, available: true },
];
let categories = [
  { id: 'mandhi', name: 'Mandhi & Rice', sort_order: 0, archived: false }, { id: 'broast_alfaham', name: 'Broast & Alfaham', sort_order: 1, archived: false },
  { id: 'beef', name: 'Beef Specials', sort_order: 2, archived: false }, { id: 'veg', name: 'Vegetarian', sort_order: 3, archived: false },
  { id: 'old', name: 'Old Specials', sort_order: 4, archived: true },
];
const tables = { menu_items: () => menu, menu_categories: () => categories, profiles: () => [{ id: 'u1', role: role(), full_name: 'Test Admin', phone: '9999999999', default_address: 'J36M+G56, Kuttikunnu Rd, Mandayapuram,' + String.fromCharCode(10) + 'Kalpetta, Kerala 673121' }] };
const setTable = (name, rows) => { if (name === 'menu_items') menu = rows; if (name === 'menu_categories') categories = rows; };

function query(table) {
  let op = 'select', payload = null, filters = [], single = false, maybe = false, order = [];
  const builder = {
    select() { return builder; }, order(column) { order.push(column); return builder; },
    eq(column, value) { filters.push([column, value]); return builder; },
    insert(rows) { op = 'insert'; payload = Array.isArray(rows) ? rows : [rows]; return builder; },
    update(fields) { op = 'update'; payload = fields; return builder; },
    delete() { op = 'delete'; return builder; },
    single() { single = true; return builder; }, maybeSingle() { maybe = true; return builder; },
    then(resolve, reject) {
      try {
        const match = row => filters.every(([c, v]) => row[c] === v);
        let rows = tables[table]();
        let out;
        if (op === 'insert') { setTable(table, [...rows, ...payload.map(r => ({ ...r }))]); out = payload; }
        else if (op === 'update') { out = []; setTable(table, rows.map(r => match(r) ? (out.push({ ...r, ...payload }), { ...r, ...payload }) : r)); }
        else if (op === 'delete') { out = rows.filter(match); setTable(table, rows.filter(r => !match(r))); }
        else { out = rows.filter(match); if (order[0] === 'name') out = [...out].sort((a, b) => a.name.localeCompare(b.name)); if (order[0] === 'sort_order') out = [...out].sort((a, b) => a.sort_order - b.sort_order); }
        out = JSON.parse(JSON.stringify(out));
        resolve(single ? (out[0] ? { data: out[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'No rows' } }) : maybe ? { data: out[0] || null, error: null } : { data: out, error: null });
      } catch (error) { reject(error); }
    },
  };
  return builder;
}

const session = () => signedIn() ? { user: { id: 'u1', email: role() + '@newform.test' } } : null;
const authListeners = new Set();
export const isSupabaseConfigured = true;
export const supabase = {
  auth: {
    getSession: async () => ({ data: { session: session() } }),
    onAuthStateChange: fn => { authListeners.add(fn); return { data: { subscription: { unsubscribe: () => authListeners.delete(fn) } } }; },
    signInWithPassword: async () => { localStorage.removeItem('mock_signed_out'); authListeners.forEach(fn => fn('SIGNED_IN', session())); return { data: { session: session() }, error: null }; },
    signOut: async () => { localStorage.setItem('mock_signed_out', '1'); authListeners.forEach(fn => fn('SIGNED_OUT', null)); return { error: null }; },
    signUp: async () => ({ data: {}, error: null }), resend: async () => ({ error: null }),
  },
  functions: { invoke: async (name, { body }) => { try { return { data: await oms(body), error: null }; } catch (error) { return { data: { error: error.message }, error: null }; } } },
  from: table => query(table),
  storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }), getPublicUrl: path => ({ data: { publicUrl: 'assets/mandhi.png?mock=' + path } }) }) },
  channel: () => { const ch = { on: (type, filter, fn) => { listeners.add(fn); return ch; }, subscribe: cb => { cb?.('SUBSCRIBED'); return ch; } }; return ch; },
  removeChannel: () => {},
};

// Console helper for demos: simulate a customer placing an order.
window.mockNewOrder = () => {
  const order = mk(++counter, 'new', 0, ['delivery', 'takeaway', 'dine_in'][counter % 3], [line('Chicken Mandhi', 1, 480, 'half'), line('Pepsi', 2, 40)]);
  orders.push(order); events[order.id] = [{ id: 1, event_type: 'order.created', detail: 'Order placed', created_at: order.created_at }];
  signal(); return order.id;
};
