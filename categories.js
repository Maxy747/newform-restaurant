import { escapeHTML } from './oms-policy.js';

export function createCategories({ client, isAdmin, onSelect, notify }) {
  let rows = [], selected = 'all', ready = false, busy = false;
  let bar, dialog, manage;
  function moveHighlight() {
    const active = bar?.querySelector('.cat-tab.active');
    const marker = bar?.querySelector('.category-highlight');
    if (!active || !marker) return;
    marker.style.width = `${active.offsetWidth}px`;
    marker.style.height = `${active.offsetHeight}px`;
    marker.style.transform = `translate(${active.offsetLeft}px,${active.offsetTop}px)`;
  }
  function render() {
    if (!bar) return;
    if (selected !== 'all' && !rows.some(row => row.id === selected && !row.archived)) {
      selected = 'all'; onSelect('all');
    }
    bar.innerHTML = '<span class="category-highlight" aria-hidden="true"></span>' +
      [{ id: 'all', name: 'All' }, ...rows.filter(row => !row.archived)].map(row =>
        `<button type="button" class="cat-tab${row.id === selected ? ' active' : ''}" data-category="${escapeHTML(row.id)}" aria-pressed="${row.id === selected}">${escapeHTML(row.name)}</button>`).join('');
    const select = document.getElementById('formCategory');
    const previous = select.value;
    // Archived categories remain available to preserve assignments when editing old dishes.
    select.innerHTML = rows.map(row => `<option value="${escapeHTML(row.id)}">${escapeHTML(row.name)}${row.archived ? ' (removed)' : ''}</option>`).join('');
    if (rows.some(row => row.id === previous)) select.value = previous;
    manage.hidden = !isAdmin();
    requestAnimationFrame(moveHighlight);
    bar.dispatchEvent(new Event('scroll'));
  }
  function renderEditor() {
    dialog.querySelector('.category-editor-list').innerHTML = rows.map(row =>
      `<form class="category-editor-row" data-id="${escapeHTML(row.id)}">
        <label>Category name${row.archived ? ' (removed)' : ''}<input name="name" required maxlength="60" value="${escapeHTML(row.name)}"></label>
        <button type="submit" class="btn-minimal">Save</button>
        <button type="button" class="btn-minimal" data-archive="${!row.archived}">${row.archived ? 'Restore' : 'Remove'}</button>
      </form>`).join('');
  }
  async function load() {
    if (!client) return;
    const { data, error } = await client.from('menu_categories').select('*').order('sort_order').order('id');
    if (error) { ready = false; if (isAdmin()) notify('Category settings unavailable. Please retry after setup.'); return; }
    rows = data; ready = true; render();
  }
  async function save(operation) {
    if (!isAdmin() || busy) return;
    if (!ready || !client) { notify('Category settings are not connected yet.'); return; }
    busy = true;
    dialog.querySelectorAll('button,input').forEach(el => el.disabled = true);
    try {
      const { error, data } = await operation().select().single();
      if (error || !data) throw error || new Error('Save was not authorized.');
      await load(); renderEditor();
      dialog.querySelector('#newCategoryName').value = '';
      notify('Categories saved');
    } catch (error) { notify(`Could not save category: ${error.message}`); }
    finally { busy = false; dialog.querySelectorAll('button,input').forEach(el => el.disabled = false); }
  }
  function init() {
    bar = document.getElementById('categoryScroll');
    rows = [...bar.querySelectorAll('[data-category]')].filter(el => el.dataset.category !== 'all').map((el,index) => ({id:el.dataset.category,name:el.textContent,sort_order:index,archived:false}));
    manage = document.createElement('button'); manage.type = 'button'; manage.className = 'btn-minimal category-manage'; manage.textContent = 'Edit categories';
    bar.closest('.category-scroll-shell').after(manage);
    dialog = document.createElement('dialog'); dialog.className = 'category-editor'; dialog.setAttribute('aria-label','Manage menu categories');
    dialog.innerHTML = `<div class="category-editor-heading"><h3>MENU CATEGORIES</h3><button type="button" class="btn-minimal" data-close>Close</button></div>
      <p>Rename or add categories. Removing a category keeps its dishes in All. Restore it here anytime.</p>
      <form id="newCategoryForm"><label>New category<input id="newCategoryName" name="name" required maxlength="60" placeholder="e.g. Desserts"></label><button class="btn-minimal" type="submit">Add category</button></form>
      <div class="category-editor-list"></div>`;
    document.body.append(dialog);
    manage.addEventListener('click', async () => { if (!isAdmin()) return; await load(); renderEditor(); dialog.showModal(); });
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('submit', event => {
      event.preventDefault();
      const form = event.target, name = form.elements.name.value.trim();
      if (!name) { notify('Enter a category name.'); return; }
      if (form.id === 'newCategoryForm') save(() => client.from('menu_categories').insert({id:crypto.randomUUID(),name,sort_order:Math.max(0,...rows.map(row => row.sort_order))+1}));
      else save(() => client.from('menu_categories').update({name}).eq('id',form.dataset.id));
    });
    dialog.addEventListener('click', event => {
      const button = event.target.closest('[data-archive]');
      if (!button) return;
      const archived = button.dataset.archive === 'true';
      save(() => client.from('menu_categories').update({archived}).eq('id',button.closest('form').dataset.id));
    });
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
  function adminChanged() { if (manage) manage.hidden = !isAdmin(); if (!isAdmin() && dialog?.open) dialog.close(); }
  return { init, load, adminChanged };
}
