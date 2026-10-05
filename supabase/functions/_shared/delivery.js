export const RESTAURANT = [76.0828979, 11.6137653];
export function deliveryFee(metres) {
 if (!Number.isFinite(metres) || metres < 0) throw new Error('Invalid route distance');
 if (metres > 40000) throw new Error('Delivery is available within 40 km by road only.');
 return Math.round(Math.max(0, metres - 5000) * 15 / 1000 * 100) / 100;
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
