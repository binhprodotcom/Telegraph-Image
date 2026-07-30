export const LIST_TYPE = {
  NONE: 'None',
  WHITE: 'White',
  BLOCK: 'Block',
};

export const LABEL = {
  NONE: 'None',
  ADULT: 'adult',
};

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
    telegramFileId: metadata.telegramFileId || '',
    telegramMessageId: Number(metadata.telegramMessageId) || 0,
    telegramStatus: metadata.telegramStatus || '',
    telegramError: metadata.telegramError || '',
  };
}

export async function getMetadata(env, id) {
  const record = await env.img_url.getWithMetadata(id);
  return record?.metadata || null;
}

export async function getOrCreateMetadata(env, id) {
  const record = await env.img_url.getWithMetadata(id);
  if (record?.metadata) return normalizeMetadata(record.metadata, id);

  const metadata = createDefaultMetadata(id);
  await putMetadata(env, id, metadata);
  return metadata;
}

export async function putMetadata(env, id, metadata) {
  await env.img_url.put(id, '', { metadata });
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
