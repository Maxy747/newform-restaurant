// Welcome splash: the inline <head> check adds `splash-open` on the first view of a visit.
// The site loads underneath; "Explore menu" (or Enter / Esc) lifts the splash away.
const root = document.documentElement;
const splash = document.getElementById('splash');

if (!root.classList.contains('splash-open') || !splash) {
  splash?.remove();
} else {
  // Keep keyboard and screen-reader focus inside the splash while it is up.
  const behind = [...document.body.children].filter(element => element !== splash && element.tagName !== 'SCRIPT');
  behind.forEach(element => { element.inert = true; });
  const enter = document.getElementById('splashEnter');
  let leaving = false;

  const finish = () => {
    splash.remove();
    root.classList.remove('splash-open');
    behind.forEach(element => { element.inert = false; });
    window.scrollTo(0, 0);
    document.removeEventListener('keydown', onKey);
  };

  const close = () => {
    if (leaving) return;
    leaving = true;
    splash.classList.add('is-leaving');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    // animationend is the normal path; the timer covers reduced motion and background tabs.
    splash.addEventListener('animationend', event => { if (event.target === splash) finish(); }, { once: true });
    setTimeout(finish, reduced ? 220 : 700);
  };

  const onKey = event => {
    if (event.key === 'Escape' || (event.key === 'Enter' && document.activeElement === document.body)) { event.preventDefault(); close(); }
  };

  enter?.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  enter?.focus({ preventScroll: true });
}
