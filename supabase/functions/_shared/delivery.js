export const RESTAURANT = [76.0828979, 11.6137653];
// Pricing comes from the admin settings (checkout_settings.delivery_max_km / delivery_fee_per_km);
// the defaults are the launch policy, 6 km at Rs20 per km.
export const DEFAULT_PRICING = {maxKm: 6, perKm: 20};
export function deliveryFee(metres, {maxKm = DEFAULT_PRICING.maxKm, perKm = DEFAULT_PRICING.perKm} = {}) {
 if (!Number.isFinite(metres) || metres < 0) throw new Error('Invalid route distance');
 if (metres > maxKm * 1000) throw new Error(`Delivery is available within ${maxKm} km by road only.`);
 // Price per road km on the exact distance, rounded up to the next rupee (Rs20/km: 3.4 km -> Rs68).
 return Math.ceil(metres * perKm / 1000);
}
export function destination(value) {
 const {lat,lng} = value || {};
 if (!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180) throw new Error('Choose a valid delivery location.');
 return [lng,lat];
}
export async function roadQuote(location, key, pricing = DEFAULT_PRICING) {
 if (!key) throw new Error('Delivery routing is not configured. Please contact the restaurant.');
 const point=destination(location);
 const response=await fetch('https://api.heigit.org/openrouteservice/v2/directions/driving-car',{
  method:'POST',headers:{Authorization:key,'Content-Type':'application/json'},
  body:JSON.stringify({coordinates:[RESTAURANT,point],radiuses:[350,350]}),signal:AbortSignal.timeout(15000)
 });
 if(!response.ok) throw new Error('Cannot calculate a driving route right now. Check your location or try again.');
 const data=await response.json();const metres=data.routes?.[0]?.summary?.distance;
 return {distance_m:metres,fee:deliveryFee(metres,pricing),latitude:point[1],longitude:point[0]};
}

export async function addressLocation(address, key) {
 if(typeof address!=='string'||address.trim().length<8||address.length>500)throw new Error('Enter a complete delivery address.');
 if(!key)throw new Error('Address lookup is not configured.');
 const plus=address.toUpperCase().match(/\b[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}\b/)?.[0];
 if(plus && (plus.indexOf('+')===8 || /kalpetta/i.test(address))){
  const module=await import('npm:open-location-code@1.0.3');
  const Constructor=module.OpenLocationCode||module.default.OpenLocationCode;
  const olc=new Constructor();
  const full=olc.isFull(plus)?plus:olc.recoverNearest(plus,RESTAURANT[1],RESTAURANT[0]);
  const area=olc.decode(full);
  return [{label:`${plus} — ${address.replace(plus,'').replace(/^\s*,\s*/,'')}`,lat:area.latitudeCenter,lng:area.longitudeCenter}];
 }
 const url=new URL('https://api.openrouteservice.org/geocode/search');
 url.search=new URLSearchParams({text:address.trim(),'boundary.country':'IND','focus.point.lon':String(RESTAURANT[0]),'focus.point.lat':String(RESTAURANT[1]),size:'10'}).toString();
 const response=await fetch(url,{headers:{Authorization:key},signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw new Error('Address search is unavailable. Please retry or use your location.');
 const data=await response.json();
 return rankMatches(data.features||[],address);
}

// Exact places (buildings, streets, house addresses) first, then area / neighbourhood names, which is
// how most addresses around Kalpetta are written. Area results are the area's centre, so they are
// marked approximate. Within each group, results naming more of the typed words come first (the
// geocoder's own order is unreliable here), then nearest; far-away places and duplicates are dropped.
const EXACT_LAYERS=['address','venue','street'];
const AREA_LAYERS=['neighbourhood','borough','locality','localadmin'];
const COMMON_WORDS=new Set(['kalpetta','wayanad','kerala','india','near','road','the','and','house','opp','junction']);
export function rankMatches(features,query=''){
 const seen=new Set();
 const words=String(query).toLowerCase().split(/[^a-z0-9]+/).filter(w=>w.length>=3&&!COMMON_WORDS.has(w));
 const score=label=>{const text=label.toLowerCase();return words.filter(w=>text.includes(w)).length;};
 const matches=features
  .filter(f=>[...EXACT_LAYERS,...AREA_LAYERS].includes(f.properties?.layer)&&f.geometry?.coordinates?.length===2)
  .map(f=>{
   const [lng,lat]=f.geometry.coordinates;
   const approximate=AREA_LAYERS.includes(f.properties.layer);
   return {label:f.properties.label+(approximate?' (area, approximate)':''),lat,lng,approximate,hits:score(f.properties.label),away:Math.hypot(lng-RESTAURANT[0],lat-RESTAURANT[1])};
  })
  .filter(m=>m.away<0.15)
  .sort((a,b)=>(a.approximate-b.approximate)||(b.hits-a.hits)||(a.away-b.away))
  .filter(m=>{const key=m.label.toLowerCase().replace(/[^a-z0-9]/g,'');if(seen.has(key))return false;seen.add(key);return true;})
  .slice(0,5)
  .map(({away,hits,...m})=>m);
 if(!matches.length)throw new Error('Address not found. Tap "Locate" to use your current location, or add a nearby landmark (e.g. bus stand, school, junction).');
 return matches;
}
