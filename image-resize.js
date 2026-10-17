// Prepares photos in the browser before upload. Originals are kept as-is when they fit the
// storage bucket's limit; only oversized files are re-encoded, at high quality (92%).
const QUALITY = 0.92;

// Width is capped at maxWidth. Safari can't encode WebP from a canvas (it silently
// returns PNG), so fall back to JPEG there.
export async function encode(bitmap, maxWidth, quality = QUALITY) {
  const scale = Math.min(1, maxWidth / bitmap.width);
  const width = Math.round(bitmap.width * scale), height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  const toBlob = (type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality));
  let blob = await toBlob('image/webp', quality);
  if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/jpeg', quality);
  if (!blob) throw new Error('This browser could not process the photo.');
  return { blob, width, height, extension: blob.type === 'image/webp' ? 'webp' : 'jpg' };
}

// Honour the camera's EXIF rotation where the browser supports it.
export async function decode(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { return createImageBitmap(file); }
}

const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// The photo to store: the untouched original when it fits the bucket's size limit, otherwise a
// high-quality copy at most maxWidth wide. `bitmap` (already decoded) supplies the dimensions.
export async function originalOrResized(file, bitmap, maxWidth, maxBytes) {
  if (file.size <= maxBytes && EXTENSIONS[file.type]) {
    return { blob: file, width: bitmap.width, height: bitmap.height, extension: EXTENSIONS[file.type] };
  }
  // Very detailed photos can still exceed the limit at 92%; step quality down until it fits.
  for (const quality of [QUALITY, 0.85, 0.75]) {
    const photo = await encode(bitmap, maxWidth, quality);
    if (photo.blob.size <= maxBytes) return photo;
  }
  throw new Error('This photo is too detailed to upload. Try a smaller copy.');
}

// Same as originalOrResized, for callers that have not decoded the file yet.
export async function photoForUpload(file, maxWidth, maxBytes) {
  const bitmap = await decode(file);
  try { return await originalOrResized(file, bitmap, maxWidth, maxBytes); }
  finally { bitmap.close?.(); }
}
