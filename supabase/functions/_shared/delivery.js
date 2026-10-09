export const RESTAURANT = [76.0828979, 11.6137653];
export function deliveryFee(metres) {
 if (!Number.isFinite(metres) || metres < 0) throw new Error('Invalid route distance');
 if (metres > 6000) throw new Error('Delivery is available within 6 km by road only.');
 // Rs20 per road km on the exact distance, rounded up to the next rupee (3.4 km -> Rs68).
 return Math.ceil(metres / 50);
}
export function destination(value) {
 const {lat,lng} = value || {};
 if (!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180) throw new Error('Choose a valid delivery location.');
 return [lng,lat];
}
export async function roadQuote(location, key) {
 if (!key) throw new Error('Delivery routing is not configured. Please contact the restaurant.');
 const point=destination(location);
 const response=await fetch('https://api.heigit.org/openrouteservice/v2/directions/driving-car',{
  method:'POST',headers:{Authorization:key,'Content-Type':'application/json'},
  body:JSON.stringify({coordinates:[RESTAURANT,point],radiuses:[350,350]}),signal:AbortSignal.timeout(15000)
 });
 if(!response.ok) throw new Error('Cannot calculate a driving route right now. Check your location or try again.');
 const data=await response.json();const metres=data.routes?.[0]?.summary?.distance;
 return {distance_m:metres,fee:deliveryFee(metres),latitude:point[1],longitude:point[0]};
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
 url.search=new URLSearchParams({text:address.trim(),'boundary.country':'IND','focus.point.lon':String(RESTAURANT[0]),'focus.point.lat':String(RESTAURANT[1]),size:'5'}).toString();
 const response=await fetch(url,{headers:{Authorization:key},signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw new Error('Address search is unavailable. Please retry or use your location.');
 const data=await response.json();
 const matches=(data.features||[]).filter(f=>['address','venue','street'].includes(f.properties?.layer)&&f.geometry?.coordinates?.length===2&&Math.abs(f.geometry.coordinates[0]-RESTAURANT[0])<0.15&&Math.abs(f.geometry.coordinates[1]-RESTAURANT[1])<0.15);
 if(!matches.length)throw new Error('Address not found precisely. Add a nearby landmark, street and postcode, or use your location.');
 return matches.map(f=>({label:f.properties.label,lat:f.geometry.coordinates[1],lng:f.geometry.coordinates[0]}));
}
