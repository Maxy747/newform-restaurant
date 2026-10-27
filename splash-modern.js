// Modern welcome splash (see splash-modern.css): plays the logo intro once the logo has decoded,
// then flies the logo into the hero logo while the stage fades, leaving the visitor on the home
// page. A tap/click anywhere, Skip, Esc, Enter or Space jumps straight to the exit.
const INTRO_MS = 2500;   // intro length before the automatic exit
const FLIGHT_MS = 900;   // matches the .sm-mark transition in splash-modern.css
const DECODE_WAIT_MS = 1500;

export function playModernSplash(splash) {
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const behind = [...document.body.children].filter(element => element !== splash && element.tagName !== 'SCRIPT');
  behind.forEach(element => { element.inert = true; });
  const mark = splash.querySelector('.sm-mark');
  const logo = splash.querySelector('.sm-ring');
  let timer = 0;
  let leaving = false;

  const play = () => {
    if (leaving || splash.classList.contains('is-playing')) return;
    splash.classList.add('is-playing');
    timer = setTimeout(leave, reduced ? 1200 : INTRO_MS);
  };
  // Start when the logo is ready (or after a short wait on a slow connection) so the intro never
  // animates an empty frame.
  Promise.race([logo.decode(), new Promise(resolve => setTimeout(resolve, DECODE_WAIT_MS))]).catch(() => {}).then(play);

  function finish() {
    splash.remove();
    root.classList.remove('splash-open');
    behind.forEach(element => { element.inert = false; });
    document.removeEventListener('keydown', onKey);
  }

  function leave() {
    if (leaving) return;
    leaving = true;
    clearTimeout(timer);
    splash.classList.add('is-playing');
    window.scrollTo({ top: 0, behavior: 'instant' });
    // Fly the badge onto the hero logo when it's on screen; otherwise just fade it out.
    const target = document.querySelector('.hero-shop-logo')?.getBoundingClientRect();
    const from = mark.getBoundingClientRect();
    const visible = target && target.width > 0 && target.bottom > 0 && target.top < innerHeight;
    if (visible && !reduced) {
      const dx = target.left + target.width / 2 - (from.left + from.width / 2);
      const dy = target.top + target.height / 2 - (from.top + from.height / 2);
      // Freeze the intro where it is so a skip mid-intro still lands a whole badge.
      splash.querySelectorAll('.sm-ring, .sm-core').forEach(element => { element.style.animation = 'none'; element.style.opacity = '1'; });
      splash.classList.add('is-leaving');
      mark.style.transform = `translate(${dx}px, ${dy}px) scale(${target.width / from.width})`;
    } else {
      splash.classList.add('is-leaving', 'sm-no-target');
    }
    setTimeout(finish, reduced ? 250 : FLIGHT_MS);
  }

  function onKey(event) {
    if (['Escape', 'Enter', ' '].includes(event.key)) { event.preventDefault(); leave(); }
  }

  splash.addEventListener('click', leave);
  document.addEventListener('keydown', onKey);
  splash.querySelector('.sm-skip')?.focus({ preventScroll: true });
}
