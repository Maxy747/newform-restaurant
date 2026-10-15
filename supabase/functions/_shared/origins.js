// Browser origins allowed to call oms-api. SITE_ORIGINS is a comma-separated list so the old
// GitHub Pages URL and the custom domain both work while the site moves; SITE_ORIGIN is the older single value.
export const DEFAULT_ORIGIN = 'https://maxy747.github.io';
export function parseOrigins(list, single) {
 const origins = String(list || single || '').split(',').map(o => o.trim().replace(/\/+$/, '')).filter(Boolean);
 return origins.length ? origins : [DEFAULT_ORIGIN];
}
// Requests without an Origin header (server-to-server, curl) are not browser requests and are let through.
export function originAllowed(origin, origins) {
 return !origin || origins.includes(origin);
}
// Echo the caller's origin when it is allowed; otherwise answer with the primary origin so the browser blocks it.
export function corsOrigin(origin, origins) {
 return origin && origins.includes(origin) ? origin : origins[0];
}
