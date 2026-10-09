// Printable invoice page: invoice.html?order=<order id>. Signed-in owners and staff use their session;
// guests use the tracking key already stored on this device. Nothing sensitive goes in the URL.
import { supabase, isSupabaseConfigured } from './supabaseClient.js';
import { createOmsApi } from './oms-client.js';
import { escapeHTML as e } from './oms-policy.js';
import { renderInvoice, renderCreditNote, guestToken } from './billing.js';

const $ = id => document.getElementById(id);
const api = createOmsApi(supabase, isSupabaseConfigured);
const PAGE = { a4: '@page { size: A4; margin: 14mm; }', receipt: '@page { size: 80mm auto; margin: 3mm; }' };
const PAPER_KEY = 'newform_invoice_paper_v1';

function setPaper(paper) {
  document.body.dataset.paper = paper;
  $('pageSize').textContent = PAGE[paper];
  document.querySelectorAll('[data-paper]').forEach(button => button.setAttribute('aria-checked', String(button.dataset.paper === paper)));
  try { localStorage.setItem(PAPER_KEY, paper); } catch { /* private mode: just don't remember */ }
}

async function load() {
  const id = new URLSearchParams(location.search).get('order') || '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('This invoice link is incomplete.');
  await supabase?.auth.getSession(); // make sure a stored session is restored before calling the API
  const { invoice } = await api('invoice', { id, token: guestToken(id) });
  document.title = `${invoice.invoice_no} · ${invoice.seller.legal_name}`;
  // Each credit note is its own document and prints on its own page.
  $('doc').innerHTML = renderInvoice(invoice) + (invoice.credit_notes || []).sort((a, b) => a.issued_at.localeCompare(b.issued_at)).map(note => renderCreditNote(note, invoice)).join('');
  $('toolbar').hidden = false;
}

document.querySelectorAll('[data-paper]').forEach(button => button.onclick = () => setPaper(button.dataset.paper));
$('printBtn').onclick = () => window.print();
let saved = 'a4';
try { saved = localStorage.getItem(PAPER_KEY) === 'receipt' ? 'receipt' : 'a4'; } catch { /* default */ }
setPaper(saved);
load().catch(error => { $('doc').innerHTML = `<p class="inv-status inv-error">${e(error.message)}</p>`; });
