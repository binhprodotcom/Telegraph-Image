export const LIST_TYPE = {
  NONE: 'None',
  WHITE: 'White',
  BLOCK: 'Block',
};

export const LABEL = {
  NONE: 'None',
  ADULT: 'adult',
};

export const KV_METADATA_MAX_BYTES = 1024;

export function createDefaultMetadata(id, overrides = {}) {
  const timestamp = Date.now();
  return {
    TimeStamp: timestamp,
    ListType: LIST_TYPE.NONE,
    Label: LABEL.NONE,
    liked: false,
    fileName: id,
    fileSize: 0,
    albumId: 'unclassified',
    capturedAt: timestamp,
    capturedMonth: new Date(timestamp).toISOString().slice(0, 7),
    tags: [],
    clientAssetId: '',
    contentHash: '',
    uploadSource: 'web',
    storageMode: 'legacy',
    storagePrimary: 'legacy',
    r2Key: '',
    r2Etag: '',
    r2Version: '',
    imageWidth: 0,
    imageHeight: 0,
    responsiveVariants: {},
    telegramFileId: '',
    telegramMessageId: 0,
    telegramStatus: '',
    telegramError: '',
    ...overrides,
  };
}

export function normalizeMetadata(metadata = {}, id) {
  const timestamp = Number(metadata.TimeStamp) || Date.now();
  const capturedAt = Number(metadata.capturedAt) || timestamp;
  return {
    ...metadata,
    ListType: metadata.ListType || LIST_TYPE.NONE,
    Label: metadata.Label || LABEL.NONE,
    TimeStamp: timestamp,
    liked: metadata.liked !== undefined ? metadata.liked : false,
    fileName: metadata.fileName || id,
    fileSize: metadata.fileSize || 0,
    albumId: metadata.albumId || 'unclassified',
    capturedAt,
    capturedMonth: metadata.capturedMonth || new Date(capturedAt).toISOString().slice(0, 7),
    tags: Array.isArray(metadata.tags) ? metadata.tags : [],
    clientAssetId: metadata.clientAssetId || '',
    contentHash: metadata.contentHash || '',
    uploadSource: metadata.uploadSource || 'web',
    storageMode: metadata.storageMode || (metadata.r2Key ? 'r2-telegram' : 'legacy'),
    storagePrimary: metadata.storagePrimary || (metadata.r2Key ? 'r2' : 'legacy'),
    r2Key: metadata.r2Key || '',
    r2Etag: metadata.r2Etag || '',
    r2Version: metadata.r2Version || '',
    imageWidth: positiveInteger(metadata.imageWidth),
    imageHeight: positiveInteger(metadata.imageHeight),
    responsiveVariants: normalizeResponsiveVariants(metadata.responsiveVariants),
    telegramFileId: metadata.telegramFileId || '',
    telegramMessageId: Number(metadata.telegramMessageId) || 0,
    telegramStatus: metadata.telegramStatus || '',
    telegramError: metadata.telegramError || '',
  };
}

function positiveInteger(value) {
  const number = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeResponsiveVariants(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const allowedWidths = new Set([480, 960, 1600]);
  const normalized = {};

  for (const [key, variant] of Object.entries(value)) {
    const width = positiveInteger(key);
    if (!allowedWidths.has(width) || !variant || typeof variant !== 'object') continue;
    const r2Key = String(variant.r2Key || '').slice(0, 512);
    if (!r2Key) continue;
    normalized[String(width)] = {
      r2Key,
      width,
      height: positiveInteger(variant.height),
      fileSize: positiveInteger(variant.fileSize),
      etag: String(variant.etag || '').slice(0, 256),
      version: String(variant.version || '').slice(0, 256),
      contentType: 'image/webp',
    };
  }

  return normalized;
}

export function createKvFileMetadata(metadata = {}, id = '') {
  const normalized = normalizeMetadata(metadata, id);
  const responsiveVariants = {};

  for (const [width, variant] of Object.entries(normalized.responsiveVariants || {})) {
    if (variant?.r2Key) responsiveVariants[width] = { r2Key: variant.r2Key };
  }

  const compact = {
    TimeStamp: normalized.TimeStamp,
    ListType: normalized.ListType,
    Label: normalized.Label,
    liked: normalized.liked,
    fileName: String(normalized.fileName || id).slice(0, 160),
    fileSize: normalized.fileSize,
    albumId: normalized.albumId,
    capturedAt: normalized.capturedAt,
    capturedMonth: normalized.capturedMonth,
    tags: normalized.tags.slice(0, 4).map(tag => String(tag).slice(0, 32)),
    storageMode: normalized.storageMode,
    storagePrimary: normalized.storagePrimary,
    r2Key: normalized.r2Key,
    imageWidth: normalized.imageWidth,
    imageHeight: normalized.imageHeight,
    responsiveVariants,
    ...(normalized.shortId ? { shortId: normalized.shortId } : {}),
  };

  // KV metadata has a hard 1024-byte limit. The complete record is stored in
  // the KV value; this compact copy only supports list views and dedupe checks.
  if (kvMetadataSize(compact) > KV_METADATA_MAX_BYTES) compact.tags = [];
  if (kvMetadataSize(compact) > KV_METADATA_MAX_BYTES) compact.fileName = compact.fileName.slice(0, 80);
  if (kvMetadataSize(compact) > KV_METADATA_MAX_BYTES) {
    delete compact.imageWidth;
    delete compact.imageHeight;
  }

  if (kvMetadataSize(compact) > KV_METADATA_MAX_BYTES) {
    throw new Error('Metadata ảnh vượt giới hạn 1024 byte của Workers KV.');
  }

  return compact;
}

export function metadataFromKvRecord(record, id = '') {
  if (!record) return null;

  let valueMetadata = null;
  if (typeof record.value === 'string' && record.value.trim()) {
    try {
      const parsed = JSON.parse(record.value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) valueMetadata = parsed;
    } catch {
      valueMetadata = null;
    }
  }

  const source = valueMetadata
    ? { ...(record.metadata || {}), ...valueMetadata }
    : record.metadata;
  return source ? normalizeMetadata(source, id) : null;
}

export function kvMetadataSize(metadata) {
  return new TextEncoder().encode(JSON.stringify(metadata || {})).byteLength;
}

export async function getMetadata(env, id) {
  const record = await env.img_url.getWithMetadata(id);
  return metadataFromKvRecord(record, id);
}

export async function getOrCreateMetadata(env, id) {
  const record = await env.img_url.getWithMetadata(id);
  const existing = metadataFromKvRecord(record, id);
  if (existing) return existing;

  const metadata = createDefaultMetadata(id);
  await putMetadata(env, id, metadata);
  return metadata;
}

export async function putMetadata(env, id, metadata) {
  const normalized = normalizeMetadata(metadata, id);
  await env.img_url.put(id, JSON.stringify(normalized), {
    metadata: createKvFileMetadata(normalized, id),
  });
}

export async function updateMetadata(env, id, updater) {
  const metadata = await getMetadata(env, id);
  if (!metadata) return null;

  const updated = updater({ ...metadata });
  await putMetadata(env, id, updated);
  return updated;
}

export function isBlocked(metadata) {
  return metadata.ListType === LIST_TYPE.BLOCK || metadata.Label === LABEL.ADULT;
}

export function isWhitelisted(metadata) {
  return metadata.ListType === LIST_TYPE.WHITE;
}
