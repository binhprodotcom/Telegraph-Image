const DEFAULT_CACHE_CONTROL = 'public, max-age=31536000, immutable';

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
    },
  });

  if (!object) throw new Error('R2 không trả về object sau khi upload.');
  return object;
}

export async function getR2Response(env, request, metadata, publicId) {
  if (!env.IMAGE_BUCKET || !metadata?.r2Key) return null;

  const object = request.method === 'HEAD'
    ? await env.IMAGE_BUCKET.head(metadata.r2Key)
    : await env.IMAGE_BUCKET.get(metadata.r2Key);

  if (!object) return null;

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', headers.get('Cache-Control') || DEFAULT_CACHE_CONTROL);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('X-BBC-Storage', 'r2');

  const filename = metadata.fileName || publicId;
  headers.set('Content-Disposition', `inline; filename="${escapeFilename(filename)}"`);

  return new Response(request.method === 'HEAD' ? null : object.body, {
    status: 200,
    headers,
  });
}

export async function deleteR2Object(env, metadata) {
  if (!env.IMAGE_BUCKET || !metadata?.r2Key) return false;
  await env.IMAGE_BUCKET.delete(metadata.r2Key);
  return true;
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
