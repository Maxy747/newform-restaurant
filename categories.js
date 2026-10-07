import { escapeHTML } from './oms-policy.js';

// Public category tabs. Categories are managed in the admin console (admin.html).
export function createCategories({ client, onSelect }) {
  let rows = [], selected = 'specials';
  let bar, bubble;
  function syncBubble() {
    const active = bar?.querySelector('.cat-tab.active');
    if (!bubble || !active) return;
    const collapsed = bar.closest('.category-scroll-shell').classList.contains('is-collapsed');
    bubble.textContent = `${active.textContent} ${collapsed ? '⌄' : '⌃'}`;
    bubble.title = collapsed ? 'Show menu categories' : 'Hide menu categories';
    bubble.setAttribute('aria-expanded', String(!collapsed));
    bubble.hidden = !collapsed;
    bar.closest('.category-scroll-shell').inert = collapsed;
  }
  function moveHighlight() {
    syncBubble();
    const active = bar?.querySelector('.cat-tab.active');
    const marker = bar?.querySelector('.category-highlight');
    if (!active || !marker) return;
    marker.style.width = `${active.offsetWidth}px`;
    marker.style.height = `${active.offsetHeight}px`;
    marker.style.transform = `translate(${active.offsetLeft}px,${active.offsetTop}px)`;
  }
  function render() {
    if (!bar) return;
    if (!['all','specials'].includes(selected) && !rows.some(row => row.id === selected && !row.archived)) {
      selected = 'all'; onSelect('all');
    }
    bar.innerHTML = '<span class="category-highlight" aria-hidden="true"></span>' +
      [{ id: 'specials', name: 'Specials' }, { id: 'all', name: 'All' }, ...rows.filter(row => !row.archived)].map(row =>
        `<button type="button" class="cat-tab${row.id === selected ? ' active' : ''}" data-category="${escapeHTML(row.id)}" aria-pressed="${row.id === selected}">${escapeHTML(row.name)}</button>`).join('');
    requestAnimationFrame(moveHighlight);
    bar.dispatchEvent(new Event('scroll'));
  }
  async function load() {
    if (!client) return;
    const { data, error } = await client.from('menu_categories').select('*').order('sort_order').order('id');
    if (error) { console.error('Could not load categories:', error.message); return; }
    rows = data; render();
  }
  function init() {
    bar = document.getElementById('categoryScroll');
    const shell = bar.closest('.category-scroll-shell');
    bubble = document.createElement('button');
    bubble.type = 'button';
    bubble.className = 'category-bubble';
    bubble.setAttribute('aria-controls', 'categoryScroll');
    bubble.title = 'Show menu categories';
    shell.before(bubble);
    // Anchor to the whole sticky bar, never the shrinking search field or tabs.
    const controls = shell.closest('.controls-wrapper');
    const searchRow = controls.querySelector('.search-filter-row');
    const anchorBubble = () => {
      controls.style.setProperty('--category-bubble-top', `${searchRow.getBoundingClientRect().bottom - controls.getBoundingClientRect().top}px`);
    };
    new ResizeObserver(anchorBubble).observe(searchRow);
    window.addEventListener('resize', anchorBubble, { passive: true });
    anchorBubble();
    bubble.addEventListener('click', () => {
      shell.dataset.revealUntil = String(performance.now() + 600);
      shell.classList.remove('is-collapsed');
      syncBubble();
      requestAnimationFrame(moveHighlight);
      const active = bar.querySelector('.cat-tab.active');
      if (active) {
        bar.scrollTo({ left: Math.max(0, active.offsetLeft - (bar.clientWidth - active.offsetWidth) / 2), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
      }
    });
    new MutationObserver(syncBubble).observe(shell, { attributes: true, attributeFilter: ['class'] });
    rows = [...bar.querySelectorAll('[data-category]')].filter(el => !['all','specials'].includes(el.dataset.category)).map((el,index) => ({id:el.dataset.category,name:el.textContent,sort_order:index,archived:false}));
    bar.addEventListener('click', event => {
      const button = event.target.closest('.cat-tab');
      if (!button || button.dataset.category === selected) return;
      selected = button.dataset.category;
      bar.querySelectorAll('.cat-tab').forEach(el => { el.classList.toggle('active',el === button); el.setAttribute('aria-pressed',String(el === button)); });
      moveHighlight();
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      bar.scrollTo({left:Math.max(0,button.offsetLeft-(bar.clientWidth-button.offsetWidth)/2),behavior:reduce ? 'instant':'smooth'});
      onSelect(selected);
    });
    new ResizeObserver(moveHighlight).observe(bar);
    document.fonts.ready.then(moveHighlight);
    render();
  }
  return { init, load };
}
