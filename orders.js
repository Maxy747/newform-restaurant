import {supabase as defaultSupabase,isSupabaseConfigured as defaultConfigured} from './supabaseClient.js';
import {escapeHTML as e,money,statusLabel as label,hasDeliveryDetails,cashOption,stepTimes,trackingCopy,orderNumber,orderRef} from './oms-policy.js';
import {createOmsApi} from './oms-client.js';
import logoSrc from './assets/newform-logo-splash.webp';

export function createOrdering({getSession,getCart,totals,toast,onPlaced,closeAll,onStaffChange=()=>{},supabase=defaultSupabase,isSupabaseConfigured=defaultConfigured}) {
 let role='customer',profile=null,channel=null,poll=null,detailId=null,detailVersion=0;
 let config={payments:false,testMode:true},placing=false,paying=false,addressEditing=false,methodChosen=false,staffLoginRedirect=false;
 let historyPage=0,realtimeTimer;
 const lastStatus=new Map();
 let deliveryQuote=null,quoteVersion=0;
 const $=id=>document.getElementById(id);
 const active=id=>$(id)?.classList.contains('active');
 const receiptKey='newform_order_receipts_v1',pendingKey='newform_pending_checkout_v1';
 const readJSON=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))||fallback;}catch{return fallback;}};
 const receipts=()=>readJSON(receiptKey,[]).filter(x=>x.id&&x.token).slice(0,20);
 const tokenFor=id=>receipts().find(x=>x.id===id)?.token;
 const showModal=id=>{closeAll();$('overlay').classList.add('active');$(id).classList.add('active');};
 const staff=()=>['admin','staff','kitchen','delivery'].includes(role);
 const api=createOmsApi(supabase,isSupabaseConfigured);
 const run=fn=>async event=>{
  const button=event?.currentTarget; if(button?.disabled)return;
  if(button)button.disabled=true;
  try{await fn(event);}catch(error){toast(error.message);}finally{if(button)button.disabled=false;}
 };
 function updateCheckout() {
  // Admin can pause home delivery; the server rejects delivery orders while it is off.
  const deliveryOff=config.deliveryEnabled===false,deliveryOption=$('orderType').querySelector('option[value="delivery"]');
  deliveryOption.disabled=deliveryOff;deliveryOption.textContent=deliveryOff?'Delivery (paused)':'Delivery';
  if(deliveryOff&&$('orderType').value==='delivery'){$('orderType').value='takeaway';quoteVersion++;}
  $('deliveryUnavailable').hidden=!deliveryOff;
  const kind=$('orderType').value;
  $('deliveryLocation').hidden=kind!=='delivery';
  if(deliveryQuote && (Date.parse(deliveryQuote.expires_at)<=Date.now() || deliveryQuote.distance_m>6000))deliveryQuote=null;
  const deliveryFee=kind==='delivery'?(deliveryQuote?.fee??0):0;
  // The per-km fee is only known once the address is checked; until then say so instead of guessing.
  $('cartTotal').textContent=money(totals().total+Number(deliveryFee))+(kind==='delivery'&&!deliveryQuote?' + delivery':'');
  $('deliveryQuoteStatus').textContent=deliveryQuote?`Delivery ₹${Number(deliveryQuote.fee)} · ${(deliveryQuote.distance_m/1000).toFixed(1)} km`:'Delivery ₹20 per km';
  // Once a quote exists the locate button and privacy note step aside.
  $('deliveryLocation').classList.toggle('has-quote',Boolean(deliveryQuote));
  $('deliveryAddressField').hidden=kind!=='delivery';
  $('tableNumberField').hidden=kind!=='dine_in';
  const summary=Boolean(getSession()&&hasDeliveryDetails(profile,kind)&&!addressEditing);
  $('deliverySummary').hidden=!summary;
  $('deliveryFields').hidden=summary;
  $('saveDeliveryBtn').hidden=!getSession();
  $('deliverySummaryTitle').textContent=kind==='delivery'?'DELIVERING TO':'ORDERING FOR';
  $('deliverySummaryText').textContent=profile?[[profile.full_name,profile.phone].filter(Boolean).join(' · '),kind==='delivery'?profile.default_address?.replace(/\s*,?\s*\n\s*/g,', '):null].filter(Boolean).join('\n'):'';
  const cash=$('codPayment'),option=cashOption(kind,config.codEnabled,totals().total);
  cash.value=option.value;cash.disabled=!option.enabled;
  cash.closest('.checkout-method').classList.toggle('is-disabled',cash.disabled);
  $('cashMethodText').replaceChildren(option.title,Object.assign(document.createElement('small'),{textContent:option.hint}));
  const whatsapp=document.querySelector('[name="paymentMethod"][value="whatsapp"]');
  // Prefer in-app payment until the customer picks a method themselves.
  if(!methodChosen&&!cash.disabled)cash.checked=true;
  if((cash.checked&&cash.disabled)||$('razorpayPayment').checked||!document.querySelector('[name="paymentMethod"]:checked'))whatsapp.checked=true;
  $('razorpayPayment').disabled=true;
  $('razorpayMethod').hidden=true;
  $('razorpayHint').textContent=config.payments?(config.testMode?'Test mode':'Pay securely'):'Setup pending';
 }
 function fillCheckout() {
  deliveryQuote=null;quoteVersion++;
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
  // Staff who just signed in here go straight to the admin console.
  if(staffLoginRedirect&&user){staffLoginRedirect=false;if(staff()){location.assign('admin.html');return;}}
  fillCheckout();
  $('ordersBtn').hidden=!staff();
  onStaffChange(staff());
  if(user)channel=supabase.channel('newform-orders-'+user.id).on('postgres_changes',{event:'*',schema:'public',table:'order_signals'},()=>{
   clearTimeout(realtimeTimer);realtimeTimer=setTimeout(refreshVisible,200);
  }).subscribe();
  if(active('accountModal'))await renderAccount();
 }
 async function refreshVisible() {
  if(document.hidden)return;
  if(active('cartDrawer')) {
   try {const next=await api('config');config={...config,codEnabled:next.codEnabled,deliveryEnabled:next.deliveryEnabled};updateCheckout();}catch { /* Server rechecks COD at checkout. */ }
  }
  if(active('trackingModal')&&detailId)await refreshDetail().catch(()=>{});
  if(active('accountModal')&&getSession())await refreshHistory().catch(()=>{});
 }
 const invalidateQuote=()=>{deliveryQuote=null;quoteVersion++;$('deliveryAddressMatches').replaceChildren();$('deliveryAddressMatches').hidden=true;updateCheckout();};
 async function searchDeliveryAddress(address) {
  invalidateQuote();const version=quoteVersion;
  $('deliveryQuoteStatus').textContent='Searching delivery address…';
  const {matches}=await api('delivery_address',{address});
  if(version!==quoteVersion)throw new Error('Address changed. Please try again.');
  const container=$('deliveryAddressMatches');container.hidden=false;
  $('deliveryQuoteStatus').textContent='Select your delivery address';
  for(const match of matches){
   const choice=document.createElement('button');choice.type='button';choice.className='btn-minimal';choice.textContent=match.label;
   choice.style.cssText='display:block;width:100%;margin-top:8px;white-space:normal;text-align:left';
   choice.onclick=run(async()=>{
    if(version!==quoteVersion)return;
    $('deliveryQuoteStatus').textContent='Checking road distance…';
    let quote;
    try { ({quote}=await api('delivery_quote',{location:{lat:match.lat,lng:match.lng}})); }
    catch(error){if(version===quoteVersion)$('deliveryQuoteStatus').textContent=error.message;throw error;}
    if(version!==quoteVersion)return;
    deliveryQuote=quote;updateCheckout();container.hidden=true;container.replaceChildren();
    toast('Delivery checked. Review total and place order.');
   });container.append(choice);
  }
  $('deliveryLocation').scrollIntoView({behavior:'smooth',block:'center'});
 }
 async function calculateDeliveryCharge(){
   invalidateQuote();const version=quoteVersion;
   if(!navigator.geolocation)throw new Error('Location is not supported by this browser.');
   const position=await new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,()=>reject(new Error('Location unavailable. Enable location access and try again.')),{enableHighAccuracy:true,timeout:15000,maximumAge:0}));
   if(version!==quoteVersion)throw new Error('Delivery details changed. Please try again.');
   $('deliveryQuoteStatus').textContent='Calculating driving route…';
   let result;
   try { result=await api('delivery_quote',{location:{lat:position.coords.latitude,lng:position.coords.longitude}}); }
   catch(error) { if(version===quoteVersion)$('deliveryQuoteStatus').textContent=error.message;throw error; }
   if(version!==quoteVersion)throw new Error('Delivery details changed. Please try again.');
   deliveryQuote=result.quote;updateCheckout();
 }
 function init() {
  $('orderType').onchange=()=>{quoteVersion++;updateCheckout();};
  $('custAddress').addEventListener('input',invalidateQuote);
  $('useDeliveryLocation').onclick=run(calculateDeliveryCharge);
  $('changeAddressBtn').onclick=()=>{addressEditing=true;updateCheckout();$('custName').focus();};
  $('saveDeliveryBtn').onclick=run(async()=>{
   const fields={full_name:$('custName').value.trim(),phone:$('custPhone').value.trim(),default_address:$('custAddress').value.trim()};
   if($('orderType').value==='delivery'&&!fields.default_address)throw new Error('Enter your delivery address.');
   await saveProfile(fields);addressEditing=false;updateCheckout();toast('Delivery details saved.');
  });
  $('closeTrackingBtn').onclick=closeTracking;
  document.querySelectorAll('[name="paymentMethod"]').forEach(input=>input.addEventListener('change',()=>{methodChosen=true;}));
  poll=setInterval(refreshVisible,10000);
  document.addEventListener('visibilitychange',refreshVisible);
  window.addEventListener('online',refreshVisible);
  updateCheckout();
 }
 async function renderAccount() {
  const content=$('accountContent');
  if(!isSupabaseConfigured){content.textContent='Account service is not configured yet.';return;}
  const user=getSession()?.user;
  if(!user) {
   content.innerHTML=`<div class="acct">
    <div class="acct-welcome"><img src="${logoSrc}" alt="" width="52" height="52"><div><h3>Welcome to NEWFORM</h3><p>Sign in to save your address and see every order. Ordering as a guest works too.</p></div></div>
    <form id="accountSignInForm" class="acct-form" novalidate>
     <label>Email<input id="accountEmail" class="form-control" type="email" autocomplete="email" placeholder="you@example.com"></label>
     <label>Password<input id="accountPassword" class="form-control" type="password" autocomplete="current-password" placeholder="Password"></label>
     <button id="accountSignIn" type="submit" class="btn-minimal btn-primary-minimal acct-wide">SIGN IN</button>
     <p class="acct-switch">New here? <button id="accountSignUp" type="button" class="acct-link">Create an account</button></p>
     <p id="authStatus" class="acct-status" role="status"></p>
    </form>
    <section class="acct-block"><h4>Track an order</h4><div id="guestHistory" class="acct-orders"></div></section>
   </div>`;
   $('accountSignInForm').onsubmit=event=>{event.preventDefault();run(()=>authenticate(false))({currentTarget:$('accountSignIn')});};
   $('accountSignUp').onclick=renderRegistration;
   renderGuestHistory();return;
  }
  const displayName=profile?.full_name||user.email.split('@')[0];
  content.innerHTML=`<div class="acct">
   <div class="acct-profile"><span class="acct-avatar" aria-hidden="true">${e(displayName.trim().charAt(0).toUpperCase())}</span><div class="acct-who"><strong>${e(displayName)}</strong><small>${e(user.email)}${profile?.phone?' · '+e(profile.phone):''}</small></div><button id="accountSignOut" type="button" class="acct-icon-btn" title="Sign out" aria-label="Sign out"><i class="fa-solid fa-right-from-bracket"></i></button></div>
   ${staff()?'<a href="admin.html" class="btn-minimal btn-primary-minimal acct-wide"><i class="fa-solid fa-gauge"></i> OPEN RESTAURANT ADMIN</a>':''}
   <div class="acct-tabs" role="tablist" aria-label="Account"><span class="acct-tab-bubble" aria-hidden="true"></span><button type="button" role="tab" class="acct-tab" data-tab="orders" aria-selected="true">Orders</button><button type="button" role="tab" class="acct-tab" data-tab="details" aria-selected="false">Details</button></div>
   <section class="acct-panel" data-panel="orders">
    <div id="accountHistory" class="acct-orders" aria-live="polite"><p class="acct-empty">Loading your orders…</p></div>
    <div class="acct-pager"><button id="historyPrev" type="button" class="acct-link">← Newer</button><button id="historyNext" type="button" class="acct-link">Older →</button></div>
    <div class="acct-block acct-guest" hidden><h4>Also on this device</h4><div id="guestHistory" class="acct-orders"></div></div>
   </section>
   <section class="acct-panel" data-panel="details" hidden>
    <div class="acct-form">
     <label>Name<input id="profileName" class="form-control" autocomplete="name" maxlength="100" value="${e(profile?.full_name)}"></label>
     <label>Phone<input id="profilePhone" type="tel" class="form-control" autocomplete="tel" maxlength="20" value="${e(profile?.phone)}"></label>
     <label>Delivery address<textarea id="profileAddress" class="form-control" rows="3" autocomplete="street-address" maxlength="500">${e(profile?.default_address)}</textarea></label>
     <button id="saveProfile" type="button" class="btn-minimal btn-primary-minimal acct-wide">SAVE DETAILS</button>
    </div>
   </section>
  </div>`;
  // Tabs: a glass bubble slides between Orders and Details.
  const tabs=[...content.querySelectorAll('.acct-tab')],bubble=content.querySelector('.acct-tab-bubble');
  const showTab=name=>{
   tabs.forEach(tab=>tab.setAttribute('aria-selected',String(tab.dataset.tab===name)));
   content.querySelectorAll('.acct-panel').forEach(panel=>{panel.hidden=panel.dataset.panel!==name;});
   const current=tabs.find(tab=>tab.dataset.tab===name);
   if(current&&bubble){bubble.style.width=current.offsetWidth+'px';bubble.style.transform=`translateX(${current.offsetLeft-4}px)`;}
  };
  tabs.forEach(tab=>tab.onclick=()=>showTab(tab.dataset.tab));
  requestAnimationFrame(()=>showTab('orders'));
  $('saveProfile').onclick=run(async()=>{await saveProfile({full_name:$('profileName').value.trim(),phone:$('profilePhone').value.trim(),default_address:$('profileAddress').value.trim()});fillCheckout();toast('Details saved.');});
  $('accountSignOut').onclick=run(async()=>{await supabase.auth.signOut();closeAll();});
  $('historyPrev').onclick=run(async()=>{historyPage=Math.max(0,historyPage-1);await refreshHistory();});
  $('historyNext').onclick=run(async()=>{historyPage++;await refreshHistory();});
  renderGuestHistory();await refreshHistory();
 }
 function renderRegistration() {
  const email=$('accountEmail')?.value || '';
  $('accountContent').innerHTML=`<form id="registrationForm" class="acct acct-form registration-screen">
   <button type="button" id="backToSignIn" class="acct-link acct-back">← Back to sign in</button>
   <h3>Create account</h3><p>Save your delivery details and order history. We’ll send an email to verify your account.</p>
   <label>Email<input id="accountEmail" class="form-control" type="email" autocomplete="email" placeholder="Email" required value="${e(email)}"></label>
   <label>Password<input id="accountPassword" class="form-control" type="password" autocomplete="new-password" placeholder="At least 6 characters" minlength="6" required></label>
   <label>Confirm password<input id="confirmAccountPassword" class="form-control" type="password" autocomplete="new-password" placeholder="Confirm password" minlength="6" required></label>
   <button type="submit" class="btn-minimal btn-primary-minimal acct-wide">CREATE ACCOUNT</button>
   <button type="button" id="resendConfirmation" class="acct-link">Resend verification email</button><p id="authStatus" class="acct-status" role="status"></p>
   </form>`;
  $('backToSignIn').onclick=()=>renderAccount();
  $('resendConfirmation').onclick=run(async()=>{
   const email=$('accountEmail').value.trim();if(!$('accountEmail').checkValidity()||!email)throw new Error('Enter a valid email.');
   const {error}=await supabase.auth.resend({type:'signup',email,options:{emailRedirectTo:location.origin+location.pathname}});
   if(error)throw error; $('authStatus').textContent='If the account needs verification, a new email has been requested. Check your inbox and spam folder.';
  });
  $('registrationForm').onsubmit=async event=>{
   event.preventDefault();
   const submit=event.currentTarget.querySelector('[type="submit"]');
   if(submit.disabled)return;
   submit.disabled=true;
   try {
    if($('accountPassword').value!==$('confirmAccountPassword').value)throw new Error('Passwords do not match.');
    await authenticate(true);
   } catch(error) { if($('authStatus'))$('authStatus').textContent=error.message;toast(error.message); }
   finally {submit.disabled=false;}
  };
  $('accountContent').scrollTop=0;
  $('accountEmail').focus({preventScroll:true});
 }
 async function authenticate(signUp) {
  const email=$('accountEmail').value.trim(),password=$('accountPassword').value;
  if(!email||!$('accountEmail').checkValidity()||!password)throw new Error('Enter a valid email and password.');
  if(signUp&&password.length<6)throw new Error('Use at least 6 characters for your password.');
  staffLoginRedirect=!signUp;
  const {data,error}=signUp?await supabase.auth.signUp({email,password,options:{emailRedirectTo:location.origin+location.pathname}}):await supabase.auth.signInWithPassword({email,password});
  if(error) { staffLoginRedirect=false;$('authStatus').textContent=error.message;throw error; }
  if(signUp&&!data.session)$('authStatus').textContent='Verification email requested. Check your inbox and spam folder. If it does not arrive, the restaurant must check its email delivery configuration.';
  else toast('Signed in.');
 }
 function renderGuestHistory() {
  const list=receipts().slice(0,5),target=$('guestHistory');
  target.closest('.acct-guest')?.toggleAttribute('hidden',!list.length);
  target.innerHTML=list.map(r=>orderCard({id:r.id})).join('')||'<p class="acct-empty">Orders you place on this device show up here.</p>';
  bindTracking(target);
  // Fill in number, status and total for each saved order.
  list.forEach(r=>api('detail',{id:r.id,token:r.token}).then(({order})=>{
   const card=target.querySelector(`[data-track="${CSS.escape(r.id)}"]`);
   if(card)card.outerHTML=orderCard(order);
   bindTracking(target);
  }).catch(()=>{}));
 }
 async function refreshHistory() {
  const target=$('accountHistory');if(!target)return;
  const {orders,count}=await api('list',{page:historyPage});
  if(!$('accountHistory'))return;
  target.innerHTML=orders.map(o=>orderCard(o)).join('')||'<p class="acct-empty">No orders yet. Your orders will show up here.</p>';
  bindTracking(target);$('historyPrev').disabled=historyPage===0;$('historyNext').disabled=(historyPage+1)*30>=count;
  $('historyPrev').closest('.acct-pager').hidden=count<=30;
 }
 const bindTracking=element=>element.querySelectorAll('[data-track]').forEach(b=>b.onclick=run(()=>openDetail(b.dataset.track)));
 const itemsHTML=order=>`<ul class="oms-items">${order.items.map(i=>`<li><span>${e(i.quantity)} × ${e(i.name)}${i.portion&&i.portion!=='single'?` <small>(${e(i.portion)})</small>`:''}</span><strong>${money(i.quantity*i.price)}</strong></li>`).join('')}</ul>`;
 function orderCard(o) {
  const when=o.created_at?new Date(o.created_at).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'}):'Tap to track';
  return `<button type="button" class="acct-order" data-track="${e(o.id)}"><span class="acct-order-main"><strong>${e(orderNumber(o))}</strong><small>${e(when)}${o.order_type?' · '+e(label(o.order_type)):''}</small></span>${o.order_status?`<span class="oms-badge ${e(o.order_status)}">${e(label(o.order_status))}</span>`:''}${o.total!=null?`<strong class="acct-order-total">${money(o.total)}</strong>`:''}<i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>`;
 }
 const paymentName=method=>({cash:'Pay at counter',cod:'Cash on delivery',whatsapp:'WhatsApp',razorpay:'Online'})[method]||method;
 async function placeOrder() {
  if(placing)return;if(!getCart().length)return toast('Your cart is empty.');
  placing=true;const button=$('placeOrderBtn');button.disabled=true;button.textContent='SAVING ORDER…';
  try {
   const payload={customer:{name:$('custName').value.trim(),phone:$('custPhone').value.trim(),address:$('custAddress').value.trim(),table:$('tableNumber').value.trim(),order_type:$('orderType').value},items:getCart().map(i=>({id:i.id,portion:i.portion?.toLowerCase()||'single',quantity:i.quantity})),method:document.querySelector('[name="paymentMethod"]:checked')?.value};
   if(!payload.customer.name||!payload.customer.phone)throw new Error('Enter your name and phone number.');
   if(payload.customer.order_type==='delivery'&&!payload.customer.address)throw new Error('Enter a delivery address.');
   if(payload.customer.order_type==='delivery'){
    if(!deliveryQuote||Date.parse(deliveryQuote.expires_at)<=Date.now()){
     button.textContent='SEARCHING ADDRESS…';
     await searchDeliveryAddress(payload.customer.address);
     return;
    }
    payload.customer.quote_id=deliveryQuote.id;
   }
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
   toast(`Order ${orderNumber(order)} placed.`);
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
  const {order:o,events,tickets,invoice}=await api('detail',{id,token:tokenFor(id)});
  if(detailId!==id||version!==detailVersion||!$('orderDetailState'))return;
  const previous=lastStatus.get(o.id);lastStatus.set(o.id,o.order_status);
  const [headline,subline]=trackingCopy(o);
  // Tell the customer when the restaurant moves their order while this screen is open.
  if(previous&&previous!==o.order_status){toast(headline);navigator.vibrate?.(150);}
  const steps=['new','confirmed','preparing','ready',...(o.order_type==='delivery'?['out_for_delivery']:[]),'completed'];
  const index=steps.indexOf(o.order_status),times=stepTimes(events);
  const clock=value=>new Date(value).toLocaleTimeString('en-IN',{hour:'numeric',minute:'2-digit'});
  const icon={new:'fa-receipt',awaiting_payment:'fa-credit-card',confirmed:'fa-circle-check',preparing:'fa-fire-burner',ready:o.order_type==='delivery'?'fa-box':'fa-bell-concierge',out_for_delivery:'fa-motorcycle',completed:'fa-face-smile',cancelled:'fa-circle-xmark'}[o.order_status]||'fa-receipt';
  const unpaid=o.payment_status!=='paid'&&o.order_status!=='cancelled';
  const payNote=o.payment_status==='paid'?'Paid':o.payment_method==='cash'?`Pay ${money(o.total)} at the counter`:o.payment_method==='cod'?`Pay ${money(o.total)} in cash on delivery`:o.payment_method==='whatsapp'?'Payment arranged with the restaurant':label(o.payment_status);
  const live=!['completed','cancelled'].includes(o.order_status);
  $('orderDetailState').innerHTML=`<section class="track-hero track-${e(o.order_status)}"><i class="fa-solid ${icon}" aria-hidden="true"></i><div><h3>${e(headline)}</h3><p>${e(subline)}</p></div></section>
   ${o.order_status==='cancelled'?'':`<ol class="track-steps">${steps.map((s,i)=>`<li class="${i<index?'done':i===index?'current':''}"><span>${e(label(s))}</span><small>${times.has(s)&&i<=index?e(clock(times.get(s))):''}</small></li>`).join('')}</ol>`}
   ${o.payment_method==='whatsapp'&&live?'<div class="track-whatsapp"><p>Want to confirm on WhatsApp too? Your order is already saved.</p><a id="sendWhatsAppOrder" class="btn-minimal" target="_blank" rel="noopener noreferrer"><i class="fa-brands fa-whatsapp"></i> SEND ON WHATSAPP</a></div>':''}
   ${o.payment_method==='razorpay'&&!['paid','refunded'].includes(o.payment_status)&&live?'<button id="payOrderBtn" class="btn-minimal btn-primary-minimal">PAY / RETRY PAYMENT</button>':''}
   <section class="track-card"><div class="oms-card-heading"><h4>ORDER ${e(orderNumber(o))} <span class="track-ref">Ref ${e(orderRef(o))}</span></h4><small>${e(new Date(o.created_at).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'}))}</small></div>
   ${itemsHTML(o)}
   <dl class="track-totals"><dt>Subtotal</dt><dd>${money(o.subtotal)}</dd><dt>GST</dt><dd>${money(o.tax)}</dd>${o.order_type==='delivery'?`<dt>Delivery${o.delivery_distance_m!=null?' · '+(o.delivery_distance_m/1000).toFixed(1)+' km':''}</dt><dd>${money(o.delivery_fee||0)}</dd>`:''}<dt class="track-total">Total</dt><dd class="track-total">${money(o.total)}</dd></dl>
   <p class="track-pay${unpaid?'':' is-paid'}"><i class="fa-solid ${unpaid?'fa-wallet':'fa-circle-check'}"></i> ${e(payNote)}</p>
   ${invoice?`<a class="btn-minimal track-invoice" href="invoice.html?order=${e(encodeURIComponent(o.id))}" target="_blank" rel="noopener"><i class="fa-solid fa-file-invoice"></i> VIEW INVOICE ${e(invoice.invoice_no)}</a>`:''}</section>
   <section class="track-card"><h4>${e(label(o.order_type).toUpperCase())}</h4><p>${e(o.customer_name||'')}${o.phone?' · '+e(o.phone):''}${o.table_number?'<br>Table '+e(o.table_number):''}${o.delivery_address?'<br>'+e(o.delivery_address):''}</p></section>
   ${live?'<p class="track-live"><span></span> Updates automatically while this screen is open</p>':''}
   <p class="track-help">Questions? Call <a href="tel:7593881112">7593 881 112</a></p>`;
  if($('payOrderBtn'))$('payOrderBtn').onclick=run(()=>pay(o));
  if($('sendWhatsAppOrder'))$('sendWhatsAppOrder').href='https://wa.me/917593881112?text='+encodeURIComponent(`NEWFORM ORDER ${orderNumber(o)} (Ref ${orderRef(o)})\n${o.items.map(i=>`${i.quantity} × ${i.name} (${i.portion||'single'})`).join('\n')}\nTotal: ${money(o.total)}\n${o.customer_name}, ${o.phone}\n${o.delivery_address||label(o.order_type)}`);
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
    const checkout=new window.Razorpay({...settings,name:'NEWFORM Restaurant',description:'Order '+orderNumber(order),prefill:{name:order.customer_name,contact:order.phone,email:getSession()?.user.email},modal:{ondismiss:()=>{toast('Checkout closed. Your order is saved; you can retry payment.');resolve();}},handler:async response=>{
     try{const verified=await api('verify',{id:order.id,token:tokenFor(order.id),...response});toast(verified.paid?'Payment verified and received.':'Payment is awaiting confirmation. We will update this order automatically.');await refreshDetail();}catch(error){toast(error.message);}finally{resolve();}
    }});
    checkout.on('payment.failed',()=>toast('Payment failed. You can retry; this order has not been marked paid.'));
    checkout.open();
   });
  } finally{paying=false;}
 }
 return {init,sessionChanged,renderAccount,placeOrder,updateCheckout,closeTracking,openDetail,getRole:()=>role};
}
