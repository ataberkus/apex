// Shared browser/server limits. Only raster images are accepted; SVG and arbitrary data URLs are not.
export const IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_SEND_BODY_BYTES = 15 * 1024 * 1024; // base64 + worst-case escaped message + JSON overhead
export const IMAGE_HELP = 'PNG, JPEG, WebP or GIF. Up to 4 images, 5 MB each, 10 MB total.';

export function fileImageType(file) {
  if (file.type && file.type !== 'application/octet-stream') return file.type.toLowerCase();
  const extension = file.name?.split('.').at(-1)?.toLowerCase();
  return {png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif'}[extension] ?? '';
}

export function imageBytes(image) {
  if (image?.type !== 'image' || !IMAGE_TYPES.includes(image.mimeType)) throw new Error('Use a PNG, JPEG, WebP or GIF image.');
  const data = image.data;
  if (typeof data !== 'string' || !data.length) throw new Error('Image data is missing. Choose the image again.');
  if (data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('Each image must be 5 MB or smaller.');
  if (data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('Image data is not valid base64. Choose the image again.');
  const bytes = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (bytes > MAX_IMAGE_BYTES) throw new Error('Each image must be 5 MB or smaller.');
  const header = atob(data.slice(0, 32));
  const matches = {
    'image/png': header.startsWith('\x89PNG\r\n\x1a\n'),
    'image/jpeg': header.startsWith('\xff\xd8\xff'),
    'image/gif': header.startsWith('GIF87a') || header.startsWith('GIF89a'),
    'image/webp': header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP',
  };
  if (!matches[image.mimeType]) throw new Error('Image contents do not match its format. Choose a valid image.');
  return bytes;
}

export function validateImages(images = [], supportsImages = true) {
  if (!Array.isArray(images)) throw new Error('Images must be an array.');
  if (images.length > MAX_IMAGES) throw new Error('Attach up to 4 images per message.');
  if (images.length && !supportsImages) throw new Error('This model does not support images. Remove the attachments or use an image-capable model.');
  let total = 0;
  const clean = images.map(image => {
    total += imageBytes(image);
    return {type: 'image', data: image.data, mimeType: image.mimeType};
  });
  if (total > MAX_TOTAL_IMAGE_BYTES) throw new Error('Images must total 10 MB or less. Remove an image or choose smaller files.');
  return clean;
}

export function imageDataUrl(image) {
  imageBytes(image);
  return `data:${image.mimeType};base64,${image.data}`;
}
