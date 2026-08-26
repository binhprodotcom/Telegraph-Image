const DEFAULT_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const RESPONSIVE_IMAGE_WIDTHS = Object.freeze([480, 960, 1600]);

export function getStoragePlan(env) {
  const requested = String(env.STORAGE_MODE || '').trim().toLowerCase();
  const hasR2 = Boolean(env.IMAGE_BUCKET);

  if (requested === 'telegram' || requested === 'telegram-only') {
    return { mode: 'telegram', useR2: false, useTelegram: true };
  }

  if (requested === 'r2' || requested === 'r2-only') {
    return { mode: 'r2', useR2: true, useTelegram: false };
  }

  if (requested === 'r2-telegram' || requested === 'dual') {
    return { mode: 'r2-telegram', useR2: true, useTelegram: true };
  }

  // Backward compatible:
  // - project without R2 binding remains Telegram-only
  // - project with R2 binding automatically becomes dual-storage
  return hasR2
    ? { mode: 'r2-telegram', useR2: true, useTelegram: true }
    : { mode: 'telegram', useR2: false, useTelegram: true };
}

export function validateR2Binding(env, plan) {
  if (plan.useR2 && !env.IMAGE_BUCKET) {
    throw new Error('STORAGE_MODE yêu cầu R2 nhưng binding IMAGE_BUCKET chưa được cấu hình.');
  }
}

export function createR2Identity(fileName, capturedAt = Date.now()) {
  const extension = safeExtension(fileName);
  const uuid = crypto.randomUUID();
  const date = new Date(Number(capturedAt) || Date.now());
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');

  return {
    publicId: `r2_${uuid.replaceAll('-', '')}.${extension}`,
    r2Key: `uploads/${year}/${month}/${uuid}.${extension}`,
    extension,
  };
}

export async function putR2Object(env, {
  key,
  file,
  contentHash = '',
  originalName = '',
  capturedAt = Date.now(),
  variantWidth = 0,
  variantHeight = 0,
  sourceKey = '',
} = {}) {
  if (!env.IMAGE_BUCKET) throw new Error('R2 binding IMAGE_BUCKET chưa được cấu hình.');
  if (!key || !file) throw new Error('Thiếu dữ liệu để lưu vào R2.');

  const contentType = file.type || contentTypeFromFilename(originalName || key) || 'application/octet-stream';
  const object = await env.IMAGE_BUCKET.put(key, await file.arrayBuffer(), {
    httpMetadata: {
      contentType,
      cacheControl: DEFAULT_CACHE_CONTROL,
    },
    customMetadata: {
      originalName: String(originalName || file.name || '').slice(0, 256),
      contentHash: String(contentHash || '').slice(0, 128),
      capturedAt: String(Number(capturedAt) || Date.now()),
      ...(variantWidth ? { variantWidth: String(variantWidth) } : {}),
      ...(variantHeight ? { variantHeight: String(variantHeight) } : {}),
      ...(sourceKey ? { sourceKey: String(sourceKey).slice(0, 512) } : {}),
    },
  });

  if (!object) throw new Error('R2 không trả về object sau khi upload.');
  return object;
}

export function createR2VariantKey(r2Key, width) {
  const normalizedWidth = normalizeResponsiveWidth(width);
  if (!r2Key || !normalizedWidth) throw new Error('Thiếu key hoặc width hợp lệ cho ảnh responsive.');
  const extensionIndex = r2Key.lastIndexOf('.');
  const base = extensionIndex > r2Key.lastIndexOf('/') ? r2Key.slice(0, extensionIndex) : r2Key;
  return `${base}.w${normalizedWidth}.webp`;
}

export function normalizeResponsiveWidth(width) {
  const value = Number.parseInt(String(width || ''), 10);
  return RESPONSIVE_IMAGE_WIDTHS.includes(value) ? value : 0;
}

export async function getR2Response(env, request, metadata, publicId, requestedWidth = 0) {
  if (!env.IMAGE_BUCKET || !metadata?.r2Key) return null;

  const width = normalizeResponsiveWidth(requestedWidth);
  const variant = width ? metadata.responsiveVariants?.[String(width)] : null;
  const objectKey = variant?.r2Key || metadata.r2Key;

  const object = request.method === 'HEAD'
    ? await env.IMAGE_BUCKET.head(objectKey)
    : await env.IMAGE_BUCKET.get(objectKey);

  if (!object) return null;

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', headers.get('Cache-Control') || DEFAULT_CACHE_CONTROL);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('X-BBC-Storage', 'r2');
  headers.set('X-BBC-Responsive-Width', variant ? String(width) : 'original');

  const filename = variant
    ? responsiveFilename(metadata.fileName || publicId, width)
    : metadata.fileName || publicId;
  headers.set('Content-Disposition', `inline; filename="${escapeFilename(filename)}"`);

  return new Response(request.method === 'HEAD' ? null : object.body, {
    status: 200,
    headers,
  });
}

export async function deleteR2Object(env, metadata) {
  if (!env.IMAGE_BUCKET || !metadata?.r2Key) return false;
  const keys = [
    metadata.r2Key,
    ...Object.values(metadata.responsiveVariants || {}).map(variant => variant?.r2Key),
  ].filter((key, index, all) => key && all.indexOf(key) === index);
  await Promise.all(keys.map(key => env.IMAGE_BUCKET.delete(key)));
  return true;
}

function responsiveFilename(filename, width) {
  const name = String(filename || 'image');
  const extensionIndex = name.lastIndexOf('.');
  const base = extensionIndex > 0 ? name.slice(0, extensionIndex) : name;
  return `${base}-w${width}.webp`;
}

function safeExtension(fileName) {
  const match = String(fileName || '').toLowerCase().match(/\.([a-z0-9]{1,10})$/);
  const extension = match?.[1] || 'bin';
  return /^[a-z0-9]+$/.test(extension) ? extension : 'bin';
}

function contentTypeFromFilename(filename) {
  const extension = safeExtension(filename);
  return ({
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    apng: 'image/apng',
    heic: 'image/heic',
    heif: 'image/heif',
    bmp: 'image/bmp',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    pdf: 'application/pdf',
  })[extension] || null;
}

function escapeFilename(filename) {
  return String(filename).replace(/["\\\r\n]/g, '_');
}
