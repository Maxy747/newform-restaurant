import {supabase as defaultSupabase,isSupabaseConfigured as defaultConfigured} from './supabaseClient.js';
import {escapeHTML as e,money,statusLabel as label,nextStatuses,indiaDayRange,hasDeliveryDetails} from './oms-policy.js';

export function createOrdering({getSession,getCart,totals,toast,onPlaced,closeAll,supabase=defaultSupabase,isSupabaseConfigured=defaultConfigured}) {
 let role='customer',profile=null,channel=null,poll=null,detailId=null,detailVersion=0,listVersion=0;
 let config={payments:false,testMode:true},placing=false,paying=false,addressEditing=false;
 let dashboardMode='orders',page=0,historyPage=0,realtimeTimer;
 const $=id=>document.getElementById(id);
 const active=id=>$(id)?.classList.contains('active');
 const receiptKey='newform_order_receipts_v1',pendingKey='newform_pending_checkout_v1';
 const readJSON=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))||fallback;}catch{return fallback;}};
 const receipts=()=>readJSON(receiptKey,[]).filter(x=>x.id&&x.token).slice(0,20);
 const tokenFor=id=>receipts().find(x=>x.id===id)?.token;
 const showModal=id=>{closeAll();$('overlay').classList.add('active');$(id).classList.add('active');};
 const staff=()=>['admin','staff','kitchen','delivery'].includes(role);
 async function api(action,data={}) {
  if(!isSupabaseConfigured) throw new Error('Ordering service is not configured yet.');
  const result=await supabase.functions.invoke('oms-api',{body:{action,...data}});
  if(result.error) {
   let message=result.error.message;
   try { const body=await result.error.context?.json();message=body?.error||message; } catch { /* transport error */ }
   throw new Error(message);
  }
  if(result.data?.error) throw new Error(result.data.error);
  return result.data;
 }
 const run=fn=>async event=>{
  const button=event?.currentTarget; if(button?.disabled)return;
  if(button)button.disabled=true;
  try{await fn(event);}catch(error){toast(error.message);}finally{if(button)button.disabled=false;}
 };
 function updateCheckout() {
  const kind=$('orderType').value;
  $('deliveryAddressField').hidden=kind!=='delivery';
  $('tableNumberField').hidden=kind!=='dine_in';
  const summary=Boolean(getSession()&&hasDeliveryDetails(profile,kind)&&!addressEditing);
  $('deliverySummary').hidden=!summary;
  $('deliveryFields').hidden=summary;
  $('saveDeliveryBtn').hidden=!getSession();
  $('deliverySummaryTitle').textContent=kind==='delivery'?'DELIVERING TO':'ORDERING FOR';
  $('deliverySummaryText').textContent=profile?[profile.full_name,profile.phone,kind==='delivery'?profile.default_address:null].filter(Boolean).join('\n'):'';
  const cash=$('codPayment');cash.value=kind==='delivery'?'cod':'cash';cash.disabled=kind==='delivery'&&totals().total<1000;
  $('cashMethodText').innerHTML=kind==='delivery'?'Cash on delivery<small>₹1,000 minimum</small>':'Cash<small>Pay at restaurant</small>';
  if(cash.disabled&&cash.checked)document.querySelector('[name="paymentMethod"][value="whatsapp"]').checked=true;
  $('razorpayPayment').disabled=!config.payments;
  $('razorpayMethod').classList.toggle('is-disabled',!config.payments);
  $('razorpayHint').textContent=config.payments?(config.testMode?'Test mode':'Pay securely'):'Setup pending';
 }
 function fillCheckout() {
  $('custName').value=profile?.full_name||'';
  $('custPhone').value=profile?.phone||'';
  $('custAddress').value=profile?.default_address||'';
  addressEditing=false;updateCheckout();
 }
 async function saveProfile(fields) {
  if(!getSession())return;
  if(!fields.full_name.trim()||!/^\+?[0-9 ()-]{8,20}$/.test(fields.phone))throw new Error('Enter your name and a valid phone number.');
  // Never send role in a profile update. Existing admin/employee roles stay intact.
  const id=getSession().user.id;
  const existing=await supabase.from('profiles').select('id').eq('id',id).maybeSingle();
  if(existing.error)throw existing.error;
  const result=existing.data?await supabase.from('profiles').update(fields).eq('id',id):await supabase.from('profiles').insert({id,...fields});
  if(result.error)throw result.error;
  profile={...profile,...fields};
 }
 async function sessionChanged() {
  const user=getSession()?.user;
  profile=null;role='customer';detailId=null;
  if(channel){supabase.removeChannel(channel);channel=null;}
  $('trackingContent').replaceChildren();
  if(user) {
   const result=await supabase.from('profiles').select('full_name,phone,default_address').eq('id',user.id).maybeSingle();
   if(getSession()?.user.id!==user.id)return;
   profile=result.data;
  }
  try{const next=await api('config');role=next.role;config=next;}catch { /* Site remains browseable if backend isn't deployed. */ }
  fillCheckout();
  $('ordersBtn').style.display=staff()?'inline-flex':'none';
  if(user)channel=supabase.channel('newform-orders-'+user.id).on('postgres_changes',{event:'*',schema:'public',table:'order_signals'},()=>{
   clearTimeout(realtimeTimer);realtimeTimer=setTimeout(refreshVisible,200);
  }).subscribe();
  if(active('accountModal'))await renderAccount();
  if(active('ordersModal')){if(staff())await renderDashboard();else closeAll();}
 }
 async function refreshVisible() {
  if(document.hidden)return;
  if(active('trackingModal')&&detailId)await refreshDetail().catch(()=>{});
  if(active('accountModal')&&getSession())await refreshHistory().catch(()=>{});
  if(active('ordersModal')&&staff())await refreshDashboard().catch(()=>{});
 }
 function init() {
  $('orderType').onchange=updateCheckout;
  $('changeAddressBtn').onclick=()=>{addressEditing=true;updateCheckout();$('custName').focus();};
  $('saveDeliveryBtn').onclick=run(async()=>{
   const fields={full_name:$('custName').value.trim(),phone:$('custPhone').value.trim(),default_address:$('custAddress').value.trim()};
   if($('orderType').value==='delivery'&&!fields.default_address)throw new Error('Enter your delivery address.');
   await saveProfile(fields);addressEditing=false;updateCheckout();toast('Delivery details saved.');
  });
  $('closeTrackingBtn').onclick=closeTracking;
  poll=setInterval(refreshVisible,15000);
  document.addEventListener('visibilitychange',refreshVisible);
  window.addEventListener('online',refreshVisible);
  updateCheckout();
 }
 async function renderAccount() {
  const content=$('accountContent');
  if(!isSupabaseConfigured){content.textContent='Account service is not configured yet.';return;}
  const user=getSession()?.user;
  if(!user) {
   content.innerHTML=`<div class="account-section"><p>Login is optional. Create an account to save your details and order history.</p><label>Email<input id="accountEmail" class="form-control" type="email" autocomplete="email" placeholder="Email"></label><label>Password<input id="accountPassword" class="form-control" type="password" autocomplete="current-password" placeholder="Password"></label><button id="accountSignIn" class="btn-minimal btn-primary-minimal">SIGN IN</button><button id="accountSignUp" class="btn-minimal">CREATE & VERIFY ACCOUNT</button><button id="resendConfirmation" class="btn-minimal">RESEND VERIFICATION EMAIL</button><p id="authStatus" role="status"></p><h4>ORDERS ON THIS DEVICE</h4><div id="guestHistory"></div></div>`;
   $('accountSignIn').onclick=run(()=>authenticate(false));$('accountSignUp').onclick=run(()=>authenticate(true));
   $('resendConfirmation').onclick=run(async()=>{
    const email=$('accountEmail').value.trim();if(!$('accountEmail').checkValidity()||!email)throw new Error('Enter a valid email.');
    const {error}=await supabase.auth.resend({type:'signup',email,options:{emailRedirectTo:location.origin+location.pathname}});
    if(error)throw error; $('authStatus').textContent='If the account needs verification, a new email has been requested. Check your inbox and spam folder.';
   });
   renderGuestHistory();return;
  }
  content.innerHTML=`<div class="account-section"><strong>${e(user.email)}</strong><label>Name<input id="profileName" class="form-control" autocomplete="name" maxlength="100" value="${e(profile?.full_name)}"></label><label>Phone<input id="profilePhone" type="tel" class="form-control" autocomplete="tel" maxlength="20" value="${e(profile?.phone)}"></label><label>Default address<textarea id="profileAddress" class="form-control" autocomplete="street-address" maxlength="500">${e(profile?.default_address)}</textarea></label><button id="saveProfile" class="btn-minimal">SAVE DETAILS</button>${staff()?'<button id="accountDashboard" class="btn-minimal">RESTAURANT DASHBOARD</button>':''}<h4>ORDER HISTORY</h4><div id="accountHistory" aria-live="polite"></div><div class="oms-actions"><button id="historyPrev" class="btn-minimal">PREVIOUS</button><button id="historyNext" class="btn-minimal">NEXT</button></div><h4>GUEST ORDERS ON THIS DEVICE</h4><div id="guestHistory"></div><button id="accountSignOut" class="btn-minimal">SIGN OUT</button></div>`;
  $('saveProfile').onclick=run(async()=>{await saveProfile({full_name:$('profileName').value.trim(),phone:$('profilePhone').value.trim(),default_address:$('profileAddress').value.trim()});fillCheckout();toast('Details saved.');});
  $('accountSignOut').onclick=run(async()=>{await supabase.auth.signOut();closeAll();});
  if($('accountDashboard'))$('accountDashboard').onclick=()=>{showModal('ordersModal');renderDashboard();};
  $('historyPrev').onclick=run(async()=>{historyPage=Math.max(0,historyPage-1);await refreshHistory();});
  $('historyNext').onclick=run(async()=>{historyPage++;await refreshHistory();});
  renderGuestHistory();await refreshHistory();
 }
 async function authenticate(signUp) {
  const email=$('accountEmail').value.trim(),password=$('accountPassword').value;
  if(!email||!$('accountEmail').checkValidity()||!password)throw new Error('Enter a valid email and password.');
  if(signUp&&password.length<6)throw new Error('Use at least 6 characters for your password.');
  const {data,error}=signUp?await supabase.auth.signUp({email,password,options:{emailRedirectTo:location.origin+location.pathname}}):await supabase.auth.signInWithPassword({email,password});
  if(error) { $('authStatus').textContent=error.message;throw error; }
  if(signUp&&!data.session)$('authStatus').textContent='Verification email requested. Check your inbox and spam folder. If it does not arrive, the restaurant must check its email delivery configuration.';
  else toast('Signed in.');
 }
 function renderGuestHistory() {
  $('guestHistory').innerHTML=receipts().map(r=>`<button class="btn-minimal" data-track="${e(r.id)}">TRACK #${e(r.id.slice(0,8))}</button>`).join('')||'<p>No guest orders on this device.</p>';
  bindTracking($('guestHistory'));
 }
 async function refreshHistory() {
  const target=$('accountHistory');if(!target)return;
  const {orders,count}=await api('list',{page:historyPage});
  if(!$('accountHistory'))return;
  target.innerHTML=orders.map(o=>orderCard(o,false)).join('')||'<p>No orders yet.</p>';
  bindTracking(target);$('historyPrev').disabled=historyPage===0;$('historyNext').disabled=(historyPage+1)*30>=count;
 }
 const bindTracking=element=>element.querySelectorAll('[data-track]').forEach(b=>b.onclick=run(()=>openDetail(b.dataset.track)));
 const itemsHTML=order=>`<ul class="oms-items">${order.items.map(i=>`<li><span>${e(i.quantity)} × ${e(i.name)}${i.portion&&i.portion!=='single'?` <small>(${e(i.portion)})</small>`:''}</span><strong>${money(i.quantity*i.price)}</strong></li>`).join('')}</ul>`;
 function orderCard(o,operations=true) {
  return `<article class="order-history-item"><div class="oms-card-heading"><strong>#${e(o.id.slice(0,8))}</strong><strong>${money(o.total)}</strong></div><span class="oms-badge ${e(o.order_status)}">${e(label(o.order_status))}</span><small>${e(new Date(o.created_at).toLocaleString())} · ${e(label(o.order_type))}</small><span>Payment: <strong>${e(label(o.payment_status))}</strong> · ${e(o.payment_method.toUpperCase())}</span>${operations?`${o.customer_name?`<p>${e(o.customer_name)} · ${e(o.phone)}<br>${e(o.delivery_address)}</p>`:''}${o.table_number?`<p>Table ${e(o.table_number)}</p>`:''}${itemsHTML(o)}`:''}<div class="oms-actions"><button class="btn-minimal" data-track="${e(o.id)}">${operations?'DETAILS / SUPPORT':'TRACK / REPORT ISSUE'}</button>${operations?nextStatuses(o,role).map(s=>`<button class="btn-minimal ${s==='cancelled'?'danger':'btn-primary-minimal'}" data-order="${e(o.id)}" data-status="${s}">${e(label(s))}</button>`).join(''):''}</div></article>`;
 }
 async function placeOrder() {
  if(placing)return;if(!getCart().length)return toast('Your cart is empty.');
  placing=true;const button=$('placeOrderBtn');button.disabled=true;button.textContent='SAVING ORDER…';
  try {
   const payload={customer:{name:$('custName').value.trim(),phone:$('custPhone').value.trim(),address:$('custAddress').value.trim(),table:$('tableNumber').value.trim(),order_type:$('orderType').value},items:getCart().map(i=>({id:i.id,portion:i.portion?.toLowerCase()||'single',quantity:i.quantity})),method:document.querySelector('[name="paymentMethod"]:checked')?.value};
   if(!payload.customer.name||!payload.customer.phone)throw new Error('Enter your name and phone number.');
   if(payload.customer.order_type==='delivery'&&!payload.customer.address)throw new Error('Enter a delivery address.');
   if(payload.customer.order_type==='dine_in'&&!payload.customer.table)throw new Error('Enter your table number.');
   // Persist only a fingerprint and random identifiers, not addresses/passwords.
   const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({user:getSession()?.user.id,...payload})))),x=>x.toString(16).padStart(2,'0')).join('');
   let pending=readJSON(pendingKey,null);
   if(pending?.digest!==digest)pending={digest,requestId:crypto.randomUUID(),token:Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('')};
   localStorage.setItem(pendingKey,JSON.stringify(pending));
   const {order}=await api('create',{...payload,requestId:pending.requestId,token:pending.token});
   localStorage.setItem(receiptKey,JSON.stringify([{id:order.id,token:pending.token},...receipts().filter(r=>r.id!==order.id)].slice(0,20)));
   localStorage.removeItem(pendingKey);onPlaced();
   await openDetail(order.id);
   toast('Order #'+order.id.slice(0,8)+' saved.');
   // Customer chooses Send WhatsApp from confirmation; no automatic external message.
  } catch(error){toast(error.message);}finally{placing=false;button.disabled=false;button.innerHTML='<i class="fa-solid fa-bag-shopping"></i> PLACE ORDER';}
 }
 function closeTracking(){detailId=null;detailVersion++;$('trackingModal').classList.remove('active');$('overlay').classList.remove('active');}
 async function openDetail(id) {
  showModal('trackingModal');detailId=id;
  $('trackingContent').innerHTML='<div id="orderDetailState" aria-live="polite">Loading order…</div><div id="orderSupport"></div>';
  await refreshDetail();
 }
 async function refreshDetail() {
  const id=detailId,version=++detailVersion;
  const {order:o,events,tickets}=await api('detail',{id,token:tokenFor(id)});
  if(detailId!==id||version!==detailVersion||!$('orderDetailState'))return;
  const steps=['new','confirmed','preparing','ready',...(o.order_type==='delivery'?['out_for_delivery']:[]),'completed'];
  const index=steps.indexOf(o.order_status);
  $('orderDetailState').innerHTML=`<div class="oms-card-heading"><h3>#${e(o.id.slice(0,8))}</h3><strong>${money(o.total)}</strong></div><p class="oms-badge ${e(o.order_status)}">${e(label(o.order_status))}</p><p>Payment: <strong>${e(label(o.payment_status))}</strong> · ${e(o.payment_method.toUpperCase())}</p><ol class="order-progress">${steps.map((s,i)=>`<li class="${i<index?'done':i===index?'current':''}">${e(label(s))}</li>`).join('')}</ol>${itemsHTML(o)}<p>Subtotal ${money(o.subtotal)} · GST ${money(o.tax)}<br><strong>Total ${money(o.total)}</strong></p><p>${e(label(o.order_type))}${o.table_number?' · Table '+e(o.table_number):''}<br>${e(o.customer_name||'')}${o.phone?' · '+e(o.phone):''}<br>${e(o.delivery_address||'')}</p><small>Updates automatically while this screen is open.</small><div class="oms-actions">${o.payment_method==='razorpay'&&!['paid','refunded'].includes(o.payment_status)&&!['cancelled','completed'].includes(o.order_status)?'<button id="payOrderBtn" class="btn-minimal btn-primary-minimal">PAY / RETRY PAYMENT</button>':''}${o.payment_method==='whatsapp'?'<a id="sendWhatsAppOrder" class="btn-minimal" target="_blank" rel="noopener noreferrer">SEND TO WHATSAPP</a>':''}${staff()&&role!=='kitchen'&&o.payment_method!=='razorpay'&&o.payment_status!=='paid'&&o.order_status!=='cancelled'?'<button id="cashReceivedBtn" class="btn-minimal">MARK CASH RECEIVED</button>':''}</div><details><summary>Status history</summary><ul class="order-audit">${events.map(event=>`<li>${e(new Date(event.created_at).toLocaleString())} — ${e(label(event.detail))}</li>`).join('')}</ul></details>`;
  if($('payOrderBtn'))$('payOrderBtn').onclick=run(()=>pay(o));
  if($('cashReceivedBtn'))$('cashReceivedBtn').onclick=run(async()=>{if(!confirm('Confirm you have received '+money(o.total)+' in cash?'))return;await api('cash',{id});await refreshDetail();});
  if($('sendWhatsAppOrder'))$('sendWhatsAppOrder').href='https://wa.me/917593881112?text='+encodeURIComponent(`NEWFORM ORDER #${o.id.slice(0,8)}\n${o.items.map(i=>`${i.quantity} × ${i.name} (${i.portion||'single'})`).join('\n')}\nTotal: ${money(o.total)}\n${o.customer_name}, ${o.phone}\n${o.delivery_address||o.order_type}`);
  // Keep unsent messages and keyboard focus intact during realtime refreshes.
  const support=$('orderSupport');
  if(['kitchen','delivery'].includes(role)){support.replaceChildren();return;}
  if(support.contains(document.activeElement)||[...support.querySelectorAll('textarea')].some(t=>t.value))return;
  support.innerHTML=`<h4>NEED HELP WITH THIS ORDER?</h4>${tickets.map(t=>`<section class="ticket"><strong>Ticket #${e(t.id.slice(0,8))}: ${e(t.subject)}</strong><span class="oms-badge">${e(label(t.status))}</span><div>${t.ticket_messages.sort((a,b)=>a.created_at.localeCompare(b.created_at)).map(m=>`<p class="ticket-message"><small>${e(m.author_role)} · ${e(new Date(m.created_at).toLocaleString())}</small><br>${e(m.message)}</p>`).join('')}</div><form data-ticket="${e(t.id)}"><label>Reply<textarea class="form-control" required maxlength="2000" name="message" rows="2"></textarea></label>${['admin','staff'].includes(role)?`<label>Status<select name="status" class="form-control">${['open','in_progress','resolved'].map(s=>`<option value="${s}" ${s===t.status?'selected':''}>${e(label(s))}</option>`).join('')}</select></label>`:''}<button class="btn-minimal" type="submit">SEND UPDATE</button></form></section>`).join('')}<details><summary>REPORT AN ISSUE / RAISE TICKET</summary><form id="newTicketForm"><label>Issue<input name="subject" class="form-control" required minlength="3" maxlength="120" placeholder="Missing item, delivery delay…"></label><label>Tell us what happened<textarea name="message" class="form-control" required maxlength="2000" rows="3"></textarea></label><button class="btn-minimal btn-primary-minimal" type="submit">RAISE TICKET</button></form></details>`;
  support.querySelectorAll('form').forEach(form=>form.onsubmit=async event=>{
   event.preventDefault();const button=form.querySelector('button');if(button.disabled)return;button.disabled=true;
   try{const fields=new FormData(form);await api('ticket',{id,token:tokenFor(id),ticketId:form.dataset.ticket,subject:fields.get('subject'),message:fields.get('message'),status:fields.get('status')});form.reset();button.blur();await refreshDetail();toast('Your ticket has been updated.');}catch(error){toast(error.message);}finally{button.disabled=false;}
  });
 }
 async function loadRazorpay() {
  if(window.Razorpay)return;
  await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://checkout.razorpay.com/v1/checkout.js';script.onload=resolve;script.onerror=()=>{script.remove();reject(new Error('Payment checkout could not load. Please retry.'));};document.head.append(script);});
 }
 async function pay(order) {
  if(paying)return;paying=true;
  try {
   const settings=await api('pay',{id:order.id,token:tokenFor(order.id)});
   if(settings.paid){toast('Payment already received.');await refreshDetail();return;}
   await loadRazorpay();
   await new Promise(resolve=>{
    const checkout=new window.Razorpay({...settings,name:'NEWFORM Restaurant',description:'Order #'+order.id.slice(0,8),prefill:{name:order.customer_name,contact:order.phone,email:getSession()?.user.email},modal:{ondismiss:()=>{toast('Checkout closed. Your order is saved; you can retry payment.');resolve();}},handler:async response=>{
     try{const verified=await api('verify',{id:order.id,token:tokenFor(order.id),...response});toast(verified.paid?'Payment verified and received.':'Payment is awaiting confirmation. We will update this order automatically.');await refreshDetail();}catch(error){toast(error.message);}finally{resolve();}
    }});
    checkout.on('payment.failed',()=>toast('Payment failed. You can retry; this order has not been marked paid.'));
    checkout.open();
   });
  } finally{paying=false;}
 }
 async function renderDashboard() {
  if(!staff()){$('ordersContent').textContent='Restaurant staff access required.';return;}
  dashboardMode=role==='kitchen'?'kitchen':role==='delivery'?'delivery':dashboardMode;
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  $('ordersContent').innerHTML=`<nav class="oms-actions" aria-label="Dashboard views">${(role==='kitchen'?['kitchen']:role==='delivery'?['delivery']:['orders','kitchen','delivery','tickets']).map(v=>`<button class="btn-minimal" data-view="${v}">${v.toUpperCase()}</button>`).join('')}</nav><form id="orderFilters" class="oms-filters"><label>From<input type="date" id="ordersFrom" class="form-control" value="${today}"></label><label>To<input type="date" id="ordersTo" class="form-control" value="${today}"></label><label>Status<select id="ordersStatus" class="form-control"><option value="">All statuses</option>${['new','confirmed','preparing','ready','out_for_delivery','completed','cancelled','awaiting_payment'].map(s=>`<option value="${s}">${label(s)}</option>`).join('')}</select></label><label>Payment<select id="ordersPayment" class="form-control"><option value="">All payments</option>${['pending','paid','failed','refunded','not_required'].map(s=>`<option>${s}</option>`).join('')}</select></label><label>Type<select id="ordersType" class="form-control"><option value="">All types</option><option value="delivery">Delivery</option><option value="takeaway">Takeaway</option><option value="dine_in">Dine in</option></select></label><label>Search<input id="ordersSearch" class="form-control" placeholder="Name or full order ID"></label><button type="submit" class="btn-minimal">APPLY FILTERS</button><button type="button" id="allOrderHistory" class="btn-minimal">ALL DATES</button></form><div id="orderAnalytics"></div><p id="ordersLiveStatus" role="status"></p><div id="dashboardOrders"></div><div class="oms-actions"><button id="ordersPrev" class="btn-minimal">PREVIOUS</button><span id="ordersPage"></span><button id="ordersNext" class="btn-minimal">NEXT</button></div>`;
  $('ordersContent').querySelectorAll('[data-view]').forEach(b=>b.onclick=run(async()=>{dashboardMode=b.dataset.view;page=0;await refreshDashboard();}));
  $('orderFilters').onsubmit=event=>{event.preventDefault();page=0;refreshDashboard().catch(error=>toast(error.message));};
  $('allOrderHistory').onclick=run(async()=>{$('ordersFrom').value='';$('ordersTo').value='';page=0;await refreshDashboard();});
  $('ordersPrev').onclick=run(async()=>{page=Math.max(0,page-1);await refreshDashboard();});
  $('ordersNext').onclick=run(async()=>{page++;await refreshDashboard();});
  await refreshDashboard();
 }
 async function refreshDashboard() {
  if(!$('dashboardOrders'))return;
  const version=++listVersion;
  $('ordersContent').querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('btn-primary-minimal',b.dataset.view===dashboardMode));
  if(dashboardMode==='tickets') {
   const {tickets}=await api('ticket_list');if(version!==listVersion)return;
   $('orderAnalytics').replaceChildren();$('ordersLiveStatus').textContent='Open support tickets';
   $('dashboardOrders').innerHTML=tickets.map(t=>`<article class="order-history-item"><strong>${e(t.subject)}</strong><span>${e(label(t.status))}</span><small>#${e(t.id.slice(0,8))}</small><button class="btn-minimal" data-track="${e(t.order_id)}">OPEN CONVERSATION</button></article>`).join('')||'<p>No open tickets.</p>';
   bindTracking($('dashboardOrders'));$('ordersPrev').disabled=true;$('ordersNext').disabled=true;$('ordersPage').textContent='';return;
  }
  const start=$('ordersFrom').value?indiaDayRange($('ordersFrom').value).start:null;
  const end=$('ordersTo').value?indiaDayRange($('ordersTo').value).end:null;
  const {orders,count}=await api('list',{mode:dashboardMode,page,start,end,status:$('ordersStatus').value,payment:$('ordersPayment').value,type:$('ordersType').value,search:$('ordersSearch').value.trim()});
  if(version!==listVersion||!$('dashboardOrders'))return;
  $('ordersLiveStatus').textContent=count+' orders · Auto-updating · '+new Date().toLocaleTimeString();
  if(dashboardMode==='kitchen') {
   $('dashboardOrders').innerHTML='<div class="kitchen-board">'+[['NEW',['new','confirmed']],['COOKING',['preparing']],['READY',['ready']]].map(([title,statuses])=>`<section><h4>${title}</h4>${orders.filter(o=>statuses.includes(o.order_status)).map(o=>orderCard(o)).join('')||'<p>No orders</p>'}</section>`).join('')+'</div>';
  } else $('dashboardOrders').innerHTML=orders.map(o=>orderCard(o)).join('')||'<p>No matching orders.</p>';
  bindTracking($('dashboardOrders'));
  $('dashboardOrders').querySelectorAll('[data-status]').forEach(b=>b.onclick=run(async()=>{
   if(b.dataset.status==='cancelled'&&!confirm('Cancel this order? Paid orders may still require a refund through Razorpay.'))return;
   await api('transition',{id:b.dataset.order,status:b.dataset.status});await refreshDashboard();
  }));
  $('ordersPrev').disabled=page===0;$('ordersNext').disabled=(page+1)*30>=count;$('ordersPage').textContent='Page '+(page+1);
  $('orderAnalytics').replaceChildren();
  if(['admin','staff'].includes(role)&&start&&end&&(+new Date(end)-+new Date(start))<=366*86400000) {
   const a=await api('analytics',{start,end});if(version!==listVersion||!$('orderAnalytics'))return;
   $('orderAnalytics').innerHTML=`<p>Overview for selected dates (all order types)</p><div class="oms-stats">${[['Orders',a.orders],['Received',money(a.revenue)],['New',a.new],['Cooking',a.preparing],['Ready',a.ready],['Completed',a.completed],['Cancelled',a.cancelled]].map(([title,value])=>`<div><small>${title}</small><strong>${e(value)}</strong></div>`).join('')}</div><p>Top items: ${a.top_items.map(i=>`${e(i.name)} × ${e(i.quantity)}`).join(' · ')||'No items yet'}</p>`;
  }
 }
 return {init,sessionChanged,renderAccount,renderDashboard,placeOrder,updateCheckout,closeTracking,openDetail,getRole:()=>role};
}
