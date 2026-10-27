// Welcome splash: the inline <head> check adds `splash-open` on every page load (not deep links).
// Restaurant photos cross-fade (slow zoom) behind the welcome while the site loads underneath.
// "Order now" lifts the splash and glides to the menu;
// Esc just lifts it, leaving the page at the top.
// The Modern style (Admin → Settings → Welcome splash) has its own intro in splash-modern.js.
import { playModernSplash } from './splash-modern.js';
import { supabase, isSupabaseConfigured } from './supabaseClient.js';
import { createOmsApi } from './oms-client.js';

const root = document.documentElement;
const SPLASH_STYLE_CACHE_KEY = 'newform_splash_style_v1';
const DECIDE_WAIT_MS = 2500;

// First visit (nothing cached): the chooser in index.html left a dark cover (`splash-deciding`)
// instead of guessing. Ask the server which style the admin picked, then stamp that one.
if (root.classList.contains('splash-deciding')) {
  decideStyle().then(style => {
    try { localStorage.setItem(SPLASH_STYLE_CACHE_KEY, style); } catch { /* storage blocked */ }
    root.dataset.splashStyle = style;
    document.body.prepend(document.getElementById(style === 'modern' ? 'splashModern' : 'splashClassic').content.cloneNode(true));
    root.classList.remove('splash-deciding');
    runSplash(document.getElementById('splash'));
  });
} else {
  runSplash(document.getElementById('splash'));
}

async function decideStyle() {
  const timeout = new Promise(resolve => setTimeout(resolve, DECIDE_WAIT_MS, 'classic'));
  const fromServer = createOmsApi(supabase, isSupabaseConfigured)('config')
    .then(config => (config.splashStyle === 'modern' ? 'modern' : 'classic'))
    .catch(() => 'classic');
  return Promise.race([fromServer, timeout]);
}

function runSplash(splash) {
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
}
