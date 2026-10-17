// Website gallery manager (Settings -> Website gallery). Admins add photos (resized in the
// browser into an 800px thumbnail; the original is kept unless it is over 8 MB), edit
// captions and delete photos. Rows live in gallery_photos; uploads in the gallery-photos bucket.
import { escapeHTML as e } from './oms-policy.js';
import { encode, decode, originalOrResized } from './image-resize.js';

const BUCKET = 'gallery-photos';
const FULL_WIDTH = 2560;
const THUMB_WIDTH = 800;
// gallery-photos bucket limit (8 MB); originals up to this size are stored untouched.
const MAX_STORED_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

export function createGalleryAdmin({ supabase, toast, run, ask }) {
  const $ = id => document.getElementById(id);
  let photos = [];
  let busy = false;

  const setStatus = message => {
    $('galleryStatus').hidden = !message;
    $('galleryStatus').textContent = message || '';
  };

  function render() {
    const grid = $('galleryAdminGrid');
    if (!photos.length) {
      grid.innerHTML = '<p class="adm-muted adm-gallery-empty">No photos yet. The Gallery is hidden on the website until you add one.</p>';
      return;
    }
    grid.innerHTML = photos.map((photo, index) => `
      <figure class="adm-gallery-item" data-id="${e(photo.id)}">
        <img src="${e(photo.thumb_url)}" alt="${e(photo.caption || `Photo ${index + 1}`)}" loading="lazy" decoding="async">
        <figcaption>
          <input type="text" maxlength="80" value="${e(photo.caption)}" placeholder="Caption (optional)" aria-label="Caption for photo ${index + 1}" data-caption>
          <button type="button" class="adm-btn adm-btn-danger adm-btn-icon" data-delete aria-label="Delete photo ${index + 1}" title="Delete photo"><i class="fa-solid fa-trash"></i></button>
        </figcaption>
      </figure>`).join('');
  }

  async function load() {
    const { data, error } = await supabase.from('gallery_photos')
      .select('id,image_url,thumb_url,storage_paths,caption,width,height,sort_order,created_at')
      .order('sort_order').order('created_at');
    if (error) throw new Error(`Could not load gallery photos: ${error.message}`);
    photos = data || [];
    render();
  }

  async function addFiles(files) {
    if (busy || !files.length) return;
    busy = true;
    $('galleryAddBtn').classList.add('is-busy');
    let added = 0;
    try {
      for (const [position, file] of files.entries()) {
        setStatus(`Adding photo ${position + 1} of ${files.length}…`);
        if (!ACCEPTED.includes(file.type)) { toast(`${file.name}: choose a JPG, PNG or WEBP photo.`, 'error'); continue; }
        if (file.size > MAX_INPUT_BYTES) { toast(`${file.name} is over 25 MB.`, 'error'); continue; }
        const bitmap = await decode(file);
        let full, thumb;
        try { [full, thumb] = [await originalOrResized(file, bitmap, FULL_WIDTH, MAX_STORED_BYTES), await encode(bitmap, THUMB_WIDTH)]; }
        finally { bitmap.close?.(); }
        const id = crypto.randomUUID();
        const paths = [`${id}-full.${full.extension}`, `${id}-800.${thumb.extension}`];
        for (const [index, part] of [full, thumb].entries()) {
          const { error } = await supabase.storage.from(BUCKET).upload(paths[index], part.blob, { cacheControl: '31536000', upsert: false, contentType: part.blob.type });
          if (error) {
            if (index) await supabase.storage.from(BUCKET).remove([paths[0]]);
            throw new Error(`Upload failed: ${error.message}`);
          }
        }
        const url = path => supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
        const nextOrder = photos.reduce((max, photo) => Math.max(max, photo.sort_order ?? 0), -1) + 1;
        const { data, error } = await supabase.from('gallery_photos').insert({
          image_url: url(paths[0]), thumb_url: url(paths[1]), storage_paths: paths,
          caption: '', width: full.width, height: full.height, sort_order: nextOrder,
        }).select().single();
        if (error || !data) {
          // Don't leave orphaned files behind when the row was rejected.
          await supabase.storage.from(BUCKET).remove(paths);
          throw new Error(error?.code === 'PGRST116' ? 'Saving was not allowed. Make sure you are signed in as admin.' : `Could not save photo: ${error?.message || 'unknown error'}`);
        }
        photos.push(data);
        added += 1;
        render();
      }
      if (added) toast(added === 1 ? 'Photo added to the gallery' : `${added} photos added to the gallery`, 'success');
    } finally {
      busy = false;
      $('galleryAddBtn').classList.remove('is-busy');
      setStatus('');
    }
  }

  async function remove(photo) {
    const choice = await ask({ title: 'Delete this photo?', message: 'It will be removed from the website gallery straight away.', choices: [{ label: 'Delete photo', value: 'yes', tone: 'danger' }, { label: 'Keep it', value: null }] });
    if (!choice) return;
    const { data, error } = await supabase.from('gallery_photos').delete().eq('id', photo.id).select();
    if (error || !data?.length) throw new Error(error ? `Could not delete photo: ${error.message}` : 'Deleting was not allowed. Make sure you are signed in as admin.');
    if (photo.storage_paths?.length) {
      const { error: storageError } = await supabase.storage.from(BUCKET).remove(photo.storage_paths);
      if (storageError) console.warn('Gallery file was not removed:', storageError.message);
    }
    photos = photos.filter(item => item.id !== photo.id);
    render();
    toast('Photo deleted', 'success');
  }

  async function saveCaption(photo, input) {
    const caption = input.value.trim().slice(0, 80);
    if (caption === photo.caption) return;
    const { data, error } = await supabase.from('gallery_photos').update({ caption }).eq('id', photo.id).select().single();
    if (error || !data) { input.value = photo.caption; throw new Error(error ? `Could not save caption: ${error.message}` : 'Saving was not allowed.'); }
    photo.caption = data.caption;
    toast('Caption saved', 'success');
  }

  $('galleryFiles').addEventListener('change', run(async event => {
    const files = [...event.target.files];
    event.target.value = '';
    await addFiles(files);
  }));
  $('galleryAdminGrid').addEventListener('click', run(async event => {
    const button = event.target.closest('[data-delete]');
    if (!button) return;
    const photo = photos.find(item => item.id === button.closest('[data-id]').dataset.id);
    if (photo) await remove(photo);
  }));
  $('galleryAdminGrid').addEventListener('change', event => {
    const input = event.target.closest('[data-caption]');
    if (!input) return;
    const photo = photos.find(item => item.id === input.closest('[data-id]').dataset.id);
    if (photo) saveCaption(photo, input).catch(error => toast(error.message, 'error'));
  });

  return { open: load };
}
