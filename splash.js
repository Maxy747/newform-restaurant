// Welcome splash: the inline <head> check adds `splash-open` on every page load (not deep links).
// Restaurant photos cross-fade (slow zoom) behind the welcome while the site loads underneath.
// "Order now" lifts the splash and glides to the menu;
// Esc just lifts it, leaving the page at the top.
// The Modern style (Admin → Settings → Welcome splash) has its own intro in splash-modern.js.
import { playModernSplash } from './splash-modern.js';

const root = document.documentElement;
const splash = document.getElementById('splash');

if (!root.classList.contains('splash-open') || !splash) {
  splash?.remove();
} else if (splash.classList.contains('splash-modern')) {
  playModernSplash(splash);
} else {
  // Keep keyboard and screen-reader focus inside the splash while it is up.
  const behind = [...document.body.children].filter(element => element !== splash && element.tagName !== 'SCRIPT');
  behind.forEach(element => { element.inert = true; });
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const slides = [...splash.querySelectorAll('.splash-slide')];
  const dots = [...splash.querySelectorAll('.splash-dots span')];
  const SLIDE_MS = 5500;
  let current = 0;
  let timer = 0;
  let leaving = false;

  const show = index => {
    slides[current]?.classList.remove('is-active');
    dots[current]?.classList.remove('is-active');
    current = index % slides.length;
    slides[current]?.classList.add('is-active');
    dots[current]?.classList.add('is-active');
  };
  const advance = () => {
    // Only move on once the next photo has actually loaded, so it never fades to blank.
    const next = slides[(current + 1) % slides.length];
    if (next?.complete && next.naturalWidth) show(current + 1);
  };
  const start = () => { if (!reduced && slides.length > 1 && !timer) timer = setInterval(advance, SLIDE_MS); };
  const stop = () => { clearInterval(timer); timer = 0; };
  const onVisibility = () => (document.hidden ? stop() : start());
  start();
  document.addEventListener('visibilitychange', onVisibility);

  const finish = destination => {
    stop();
    splash.remove();
    root.classList.remove('splash-open');
    behind.forEach(element => { element.inert = false; });
    window.scrollTo({ top: 0, behavior: 'instant' });
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVisibility);
    // The site's own nav links own the eased scroll, so reuse them for the destination.
    if (destination) document.querySelector(`.nav-link[href="${destination}"]`)?.click();
  };

  const close = destination => {
    if (leaving) return;
    leaving = true;
    splash.classList.add('is-leaving');
    let done = false;
    const once = () => { if (!done) { done = true; finish(destination); } };
    // animationend is the normal path; the timer covers reduced motion and background tabs.
    splash.addEventListener('animationend', event => { if (event.target === splash) once(); });
    setTimeout(once, reduced ? 220 : 700);
  };

  const onKey = event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  };

  document.getElementById('splashEnter')?.addEventListener('click', () => close('#menuSection'));
  document.addEventListener('keydown', onKey);
  document.getElementById('splashEnter')?.focus({ preventScroll: true });
}
