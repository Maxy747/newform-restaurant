// Shrinks photos in the browser before they are uploaded, so the public site downloads
// small WebP files instead of multi-megabyte camera originals (Supabase egress is metered).

// Largest side we keep is maxWidth wide. Safari can't encode WebP from a canvas (it silently
// returns PNG), so fall back to JPEG there.
export async function encode(bitmap, maxWidth) {
  const scale = Math.min(1, maxWidth / bitmap.width);
  const width = Math.round(bitmap.width * scale), height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  const toBlob = (type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality));
  let blob = await toBlob('image/webp', 0.8);
  if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/jpeg', 0.84);
  if (!blob) throw new Error('This browser could not process the photo.');
  return { blob, width, height, extension: blob.type === 'image/webp' ? 'webp' : 'jpg' };
}

// Honour the camera's EXIF rotation where the browser supports it.
export async function decode(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { return createImageBitmap(file); }
}

// One resized copy of a file, at most maxWidth wide.
export async function resizePhoto(file, maxWidth) {
  const bitmap = await decode(file);
  try { return await encode(bitmap, maxWidth); }
  finally { bitmap.close?.(); }
}
