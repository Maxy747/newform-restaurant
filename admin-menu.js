import { escapeHTML as e } from './oms-policy.js';
import { buildMenuRow, menuPrices } from './admin-policy.js';

const STORAGE_MARKER = '/storage/v1/object/public/menu-images/';
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

// Menu and category management. Writes go straight to Supabase and rely on the existing admin-only RLS policies.
export function createMenuAdmin({ supabase, toast, run, isAdmin }) {
  const $ = id => document.getElementById(id);
  let items = [], categories = [], loaded = false, editing = null, photoFile = null, photoRemoved = false, previewUrl = null;

  const categoryName = id => categories.find(row => row.id === id)?.name || id || 'Uncategorised';
  const storagePath = url => (typeof url === 'string' && url.includes(STORAGE_MARKER)) ? url.split(STORAGE_MARKER)[1] : null;
  const hasPhoto = image => Boolean(image) && !/(^|\/)assets\/hero\.png(\?.*)?$/.test(image);

  async function load() {
    const [menu, cats] = await Promise.all([
      supabase.from('menu_items').select('*').order('name'),
      supabase.from('menu_categories').select('*').order('sort_order').order('id'),
    ]);
    if (menu.error) throw menu.error;
    if (cats.error) throw cats.error;
    items = menu.data; categories = cats.data; loaded = true;
  }

  async function open() {
    if (!isAdmin()) return;
    if (!loaded) $('menuList').innerHTML = '<p class="adm-empty">Loading menu…</p>';
    await load();
    renderFilters();
    render();
  }

  function renderFilters() {
    const filter = $('menuCategoryFilter'), current = filter.value;
    filter.innerHTML = '<option value="">All categories</option>' + categories.map(row => `<option value="${e(row.id)}">${e(row.name)}${row.archived ? ' (hidden)' : ''}</option>`).join('');
    filter.value = categories.some(row => row.id === current) ? current : '';
    $('dishCategory').innerHTML = categories.map(row => `<option value="${e(row.id)}">${e(row.name)}${row.archived ? ' (hidden)' : ''}</option>`).join('');
  }

  const rupees = value => '₹' + Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  function priceText(item) {
    const prices = menuPrices(item);
    return prices ? `Q ${rupees(prices.quarter)} · H ${rupees(prices.half)} · F ${rupees(prices.full)}` : rupees(item.price);
  }

  function render() {
    const query = $('menuSearch').value.trim().toLowerCase();
    const category = $('menuCategoryFilter').value, stock = $('menuStockFilter').value;
    const visible = items.filter(item => (!query || item.name.toLowerCase().includes(query))
      && (!category || item.category === category)
      && (!stock || (stock === 'out') === (item.available === false)));
    const out = items.filter(item => item.available === false).length;
    $('menuSummary').textContent = `${items.length} dishes · ${out} out of stock${visible.length !== items.length ? ` · showing ${visible.length}` : ''}`;
    $('menuList').innerHTML = visible.map(item => `<article class="adm-dish${item.available === false ? ' is-out' : ''}">
        <button type="button" class="adm-dish-main" data-edit="${e(item.id)}" aria-label="Edit ${e(item.name)}">
          ${hasPhoto(item.image) ? `<img src="${e(item.image)}" alt="" loading="lazy">` : '<span class="adm-dish-noimg"><i class="fa-solid fa-image"></i></span>'}
          <span class="adm-dish-text">
            <strong><i class="adm-diet adm-diet-${e(item.diet)}" title="${item.diet === 'veg' ? 'Veg' : 'Non-veg'}"></i>${e(item.name)}${item.tag ? ` <span class="adm-chip">${e(item.tag)}</span>` : ''}</strong>
            <small>${e(categoryName(item.category))} · ${e(priceText(item))}</small>
          </span>
        </button>
        <label class="adm-stock" title="${item.available === false ? 'Out of stock' : 'In stock'}">
          <button type="button" class="adm-switch adm-switch-sm" role="switch" aria-checked="${item.available !== false}" aria-label="${e(item.name)} in stock" data-stock="${e(item.id)}"><span></span></button>
          <small>${item.available === false ? 'Out' : 'In stock'}</small>
        </label>
      </article>`).join('') || '<p class="adm-empty">No dishes match.</p>';
  }

  async function toggleStock(id, button) {
    const item = items.find(row => row.id === id);
    if (!item) return;
    const available = item.available === false;
    const { data, error } = await supabase.from('menu_items').update({ available }).eq('id', id).select().single();
    if (error) throw error;
    Object.assign(item, data);
    render();
    toast(available ? `${item.name} is back in stock` : `${item.name} marked out of stock`, 'success');
    button?.blur();
  }

  // ----- dish editor -----
  function setPreview(src) {
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    $('dishPhotoPreview').innerHTML = src ? `<img src="${e(src)}" alt="Dish photo preview">` : '<i class="fa-solid fa-image"></i>';
    $('dishPhotoRemove').hidden = !src;
  }

  function syncPricing() {
    const multi = $('dishPortionType').value === 'multi';
    $('singlePriceRow').hidden = multi;
    $('multiPriceRow').hidden = !multi;
  }

  function openEditor(item = null) {
    if (!categories.length) { toast('Add a category before adding dishes.', 'error'); return; }
    editing = item;
    photoFile = null; photoRemoved = false;
    const form = $('dishForm');
    form.reset();
    $('dishError').hidden = true;
    $('dishDialogTitle').textContent = item ? 'Edit dish' : 'Add dish';
    $('dishSave').textContent = item ? 'Save changes' : 'Add to menu';
    $('dishDelete').hidden = !item;
    const prices = item ? menuPrices(item) : null;
    form.elements.name.value = item?.name || '';
    form.elements.category.value = item?.category || (categories.find(row => !row.archived) || categories[0]).id;
    form.elements.diet.value = item?.diet || 'non-veg';
    form.elements.tag.value = item?.tag || '';
    form.elements.portionType.value = item?.portionType || 'single';
    form.elements.price.value = item?.price ?? '';
    form.elements.quarter.value = prices?.quarter ?? '';
    form.elements.half.value = prices?.half ?? '';
    form.elements.full.value = prices?.full ?? '';
    form.elements.description.value = item?.description || '';
    form.elements.available.checked = item ? item.available !== false : true;
    setPreview(item && hasPhoto(item.image) ? item.image : null);
    syncPricing();
    $('dishDialog').showModal();
    form.elements.name.focus();
  }

  async function uploadPhoto(file) {
    const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.type];
    const path = `${crypto.randomUUID()}.${extension}`;
    const { error } = await supabase.storage.from('menu-images').upload(path, file, { cacheControl: '31536000', upsert: false, contentType: file.type });
    if (error) throw new Error(`Photo upload failed: ${error.message}`);
    return { path, url: supabase.storage.from('menu-images').getPublicUrl(path).data.publicUrl };
  }

  async function removeStoredPhoto(url) {
    const path = storagePath(url);
    if (!path) return;
    const { error } = await supabase.storage.from('menu-images').remove([path]);
    if (error) console.warn('Old menu photo was not removed:', error.message);
  }

  async function saveDish() {
    const form = $('dishForm'), fields = Object.fromEntries(new FormData(form));
    fields.available = form.elements.available.checked;
    let row;
    try { row = buildMenuRow(fields); }
    catch (error) { $('dishError').textContent = error.message; $('dishError').hidden = false; $('dishError').scrollIntoView({ block: 'nearest' }); return; }
    $('dishError').hidden = true;
    const previousImage = editing?.image || null;
    let uploaded = null;
    if (photoFile) { uploaded = await uploadPhoto(photoFile); row.image = uploaded.url; }
    else if (photoRemoved) row.image = null;
    else if (!editing) row.image = null;
    const request = editing
      ? supabase.from('menu_items').update(row).eq('id', editing.id)
      : supabase.from('menu_items').insert({ id: crypto.randomUUID(), ...row });
    const { data, error } = await request.select().single();
    if (error || !data) {
      // Don't leave an orphaned upload behind when the row was rejected.
      if (uploaded) await supabase.storage.from('menu-images').remove([uploaded.path]);
      throw new Error(error?.code === 'PGRST116' ? 'Save was not allowed. Make sure you are signed in as admin.' : `Could not save dish: ${error?.message || 'unknown error'}`);
    }
    if (previousImage && previousImage !== data.image) await removeStoredPhoto(previousImage);
    const index = items.findIndex(item => item.id === data.id);
    if (index === -1) items.push(data); else items[index] = data;
    items.sort((a, b) => a.name.localeCompare(b.name));
    $('dishDialog').close();
    render();
    toast(editing ? `Saved "${data.name}"` : `Added "${data.name}" to the menu`, 'success');
  }

  async function deleteDish() {
    if (!editing || !confirm(`Delete "${editing.name}" from the menu? Past orders keep their details. To hide it temporarily, mark it out of stock instead.`)) return;
    const { data, error } = await supabase.from('menu_items').delete().eq('id', editing.id).select('id');
    if (error) throw new Error(`Could not delete: ${error.message}`);
    if (!data?.length) throw new Error('Delete was not allowed. Make sure you are signed in as admin.');
    await removeStoredPhoto(editing.image);
    items = items.filter(item => item.id !== editing.id);
    $('dishDialog').close();
    render();
    toast(`Deleted "${editing.name}"`, 'success');
  }

  // ----- categories -----
  const dishCount = id => { const count = items.filter(item => item.category === id).length; return `${count} ${count === 1 ? 'dish' : 'dishes'}`; };
  function renderCategories() {
    $('categoryList').innerHTML = categories.map((row, index) => `<form class="adm-category${row.archived ? ' is-archived' : ''}" data-id="${e(row.id)}">
        <input name="name" value="${e(row.name)}" maxlength="60" required aria-label="Category name">
        <span class="adm-muted">${dishCount(row.id)}</span>
        <div class="adm-category-actions">
          <button type="button" class="adm-icon-btn" data-move="-1" aria-label="Move up"${index === 0 ? ' disabled' : ''}><i class="fa-solid fa-arrow-up"></i></button>
          <button type="button" class="adm-icon-btn" data-move="1" aria-label="Move down"${index === categories.length - 1 ? ' disabled' : ''}><i class="fa-solid fa-arrow-down"></i></button>
          <button type="submit" class="adm-btn">Rename</button>
          <button type="button" class="adm-btn${row.archived ? '' : ' adm-btn-ghost'}" data-archive="${!row.archived}">${row.archived ? 'Restore' : 'Hide'}</button>
        </div>
      </form>`).join('') || '<p class="adm-empty">No categories yet.</p>';
  }

  async function categoryWrite(request, message) {
    const { data, error } = await request.select();
    if (error) throw new Error(`Could not save category: ${error.message}`);
    if (!data?.length) throw new Error('Save was not allowed. Make sure you are signed in as admin.');
    await load(); renderCategories(); renderFilters(); render();
    toast(message, 'success');
  }

  async function moveCategory(id, direction) {
    const index = categories.findIndex(row => row.id === id), other = categories[index + direction];
    if (!other) return;
    // Normalise ordering first so equal sort_order values can still be swapped.
    const ordered = categories.map((row, position) => ({ ...row, sort_order: position }));
    [ordered[index].sort_order, ordered[index + direction].sort_order] = [ordered[index + direction].sort_order, ordered[index].sort_order];
    const changed = ordered.filter(row => row.sort_order !== categories.find(c => c.id === row.id).sort_order);
    for (const row of changed) {
      const { error } = await supabase.from('menu_categories').update({ sort_order: row.sort_order }).eq('id', row.id);
      if (error) throw new Error(`Could not reorder: ${error.message}`);
    }
    await load(); renderCategories(); renderFilters();
  }

  // ----- wiring -----
  $('menuSearch').addEventListener('input', render);
  $('menuCategoryFilter').addEventListener('change', render);
  $('menuStockFilter').addEventListener('change', render);
  $('addDishBtn').onclick = () => openEditor();
  $('menuList').addEventListener('click', event => {
    const stock = event.target.closest('[data-stock]');
    if (stock) { run(() => toggleStock(stock.dataset.stock, stock))({ currentTarget: stock }); return; }
    const edit = event.target.closest('[data-edit]');
    if (edit) openEditor(items.find(item => item.id === edit.dataset.edit));
  });
  $('dishPortionType').addEventListener('change', syncPricing);
  $('dishPhoto').addEventListener('change', event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { toast('Choose a JPG, PNG or WEBP photo.', 'error'); return; }
    if (file.size > MAX_PHOTO_BYTES) { toast('Photos must be 5 MB or smaller.', 'error'); return; }
    photoFile = file; photoRemoved = false;
    setPreview(null);
    previewUrl = URL.createObjectURL(file);
    $('dishPhotoPreview').innerHTML = `<img src="${previewUrl}" alt="Dish photo preview">`;
    $('dishPhotoRemove').hidden = false;
  });
  $('dishPhotoRemove').onclick = () => { photoFile = null; photoRemoved = true; setPreview(null); };
  $('dishForm').addEventListener('submit', event => { event.preventDefault(); run(saveDish)({ currentTarget: $('dishSave') }); });
  $('dishDelete').onclick = run(deleteDish);
  $('dishDialog').addEventListener('close', () => { setPreview(null); editing = null; photoFile = null; });

  $('manageCategoriesBtn').onclick = run(async () => { await load(); renderCategories(); $('categoryDialog').showModal(); });
  $('newCategoryForm').onsubmit = event => {
    event.preventDefault();
    const form = event.currentTarget, name = form.elements.name.value.trim();
    if (!name) return;
    run(async () => {
      await categoryWrite(supabase.from('menu_categories').insert({ id: crypto.randomUUID(), name, sort_order: Math.max(0, ...categories.map(row => row.sort_order)) + 1 }), `Added "${name}"`);
      form.reset();
    })({ currentTarget: form.querySelector('button') });
  };
  $('categoryList').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.target, name = form.elements.name.value.trim();
    if (!name) return;
    run(() => categoryWrite(supabase.from('menu_categories').update({ name }).eq('id', form.dataset.id), `Renamed to "${name}"`))({ currentTarget: event.submitter });
  });
  $('categoryList').addEventListener('click', event => {
    const archive = event.target.closest('[data-archive]');
    const move = event.target.closest('[data-move]');
    const id = event.target.closest('form')?.dataset.id;
    if (archive) run(() => categoryWrite(supabase.from('menu_categories').update({ archived: archive.dataset.archive === 'true' }).eq('id', id), archive.dataset.archive === 'true' ? 'Category hidden from customers' : 'Category restored'))({ currentTarget: archive });
    if (move) run(() => moveCategory(id, Number(move.dataset.move)))({ currentTarget: move });
  });

  return { open };
}
