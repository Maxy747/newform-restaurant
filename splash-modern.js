// Modern welcome splash (see splash-modern.css): plays the logo intro once the logo has decoded,
// then glides the badge onto the hero logo while the stage fades, leaving the visitor on the home
// page. The badge uses the hero's own image and picks up its frame on the way, and the hero logo
// fades in underneath it before the splash goes, so the hand-off can't be seen.
const INTRO_MS = 2500;    // intro length before the automatic exit
const FLIGHT_MS = 1100;   // matches the .sm-mark transition in splash-modern.css
const HANDOFF_MS = 350;   // hero logo (and its glow) fades in under the landed badge
const DECODE_WAIT_MS = 1500;

export function playModernSplash(splash) {
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const behind = [...document.body.children].filter(element => element !== splash && element.tagName !== 'SCRIPT');
  behind.forEach(element => { element.inert = true; });
  const mark = splash.querySelector('.sm-mark');
  const badge = splash.querySelector('.sm-logo');
  const hero = document.querySelector('.hero-shop-logo');
  let leaving = false;

  const play = () => {
    if (leaving || splash.classList.contains('is-playing')) return;
    splash.classList.add('is-playing');
    setTimeout(leave, reduced ? 1200 : INTRO_MS);
  };
  // Start when the logo is ready (or after a short wait on a slow connection) so the intro never
  // animates an empty frame.
  Promise.race([splash.querySelector('.sm-ring').decode(), new Promise(resolve => setTimeout(resolve, DECODE_WAIT_MS))]).catch(() => {}).then(play);

  function finish() {
    splash.remove();
    root.classList.remove('splash-open');
    behind.forEach(element => { element.inert = false; });
  }

  function leave() {
    leaving = true;
    window.scrollTo({ top: 0, behavior: 'instant' });
    const target = hero?.getBoundingClientRect();
    const from = mark.getBoundingClientRect();
    const visible = target && target.width > 0 && target.bottom > 0 && target.top < innerHeight;
    if (!visible || reduced) {
      splash.classList.add('is-leaving', 'sm-no-target');
      setTimeout(finish, reduced ? 250 : 450);
      return;
    }
    // Hide the hero logo while the badge travels so there's only ever one logo on screen.
    hero.style.opacity = '0';
    const scale = target.width / from.width;
    const frame = getComputedStyle(hero);
    splash.classList.add('is-leaving');
    mark.style.transform = `translate(${target.left + target.width / 2 - (from.left + from.width / 2)}px, ${target.top + target.height / 2 - (from.top + from.height / 2)}px) scale(${scale})`;
    // Border in the badge's unscaled pixels, so after scaling it matches the hero's exactly.
    badge.style.borderWidth = `${parseFloat(frame.borderTopWidth) / scale}px`;
    badge.style.borderColor = frame.borderTopColor;

    setTimeout(() => {
      hero.style.transition = `opacity ${HANDOFF_MS}ms ease`;
      hero.style.opacity = '';
      setTimeout(() => {
        finish();
        hero.style.transition = '';
      }, HANDOFF_MS);
    }, FLIGHT_MS);
  }
}
