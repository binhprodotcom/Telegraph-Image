const ASSET_KEY_PREFIX = '__bbc_asset__:';
const HASH_KEY_PREFIX = '__bbc_hash__:';
const MAX_CLIENT_ASSET_ID_LENGTH = 768;

export function isDedupeStorageKey(name) {
  return typeof name === 'string' && (
    name.startsWith(ASSET_KEY_PREFIX)
    || name.startsWith(HASH_KEY_PREFIX)
  );
}

export function normalizeClientAssetId(value) {
  const normalized = String(value || '').trim().slice(0, MAX_CLIENT_ASSET_ID_LENGTH);
  return normalized || '';
}

export function createLegacyClientAssetId({ fileName = '', fileSize = 0, capturedAt = 0 } = {}) {
  const name = String(fileName || '').trim();
  const size = Math.max(0, Number(fileSize) || 0);
  const date = Math.max(0, Number(capturedAt) || 0);
  if (!name || !date) return '';
  return `v1|${name}|${size}|${date}`;
}

export async function sha256Hex(value) {
  const bytes = value instanceof ArrayBuffer
    ? value
    : value instanceof Uint8Array
      ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
      : new TextEncoder().encode(String(value)).buffer;

  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function contentHashForFile(file) {
  return sha256Hex(await file.arrayBuffer());
}

export async function assetIndexKey(clientAssetId) {
  const normalized = normalizeClientAssetId(clientAssetId);
  if (!normalized) return '';
  return ASSET_KEY_PREFIX + await sha256Hex(normalized);
}

export function contentHashIndexKey(contentHash) {
  const normalized = String(contentHash || '').trim().toLowerCase();
  return normalized ? HASH_KEY_PREFIX + normalized : '';
}

export async function findDuplicateByClientAssetId(env, clientAssetId) {
  if (!env.img_url) return null;
  const key = await assetIndexKey(clientAssetId);
  if (!key) return null;
  return readValidIndex(env, key);
}

export async function findDuplicateByContentHash(env, contentHash) {
  if (!env.img_url) return null;
  const key = contentHashIndexKey(contentHash);
  if (!key) return null;
  return readValidIndex(env, key);
}

export async function saveDedupeIndexes(env, {
  clientAssetId = '',
  contentHash = '',
  fileId,
  shortId = null,
  albumId = 'unclassified',
  capturedAt = Date.now(),
} = {}) {
  if (!env.img_url || !fileId) return;

  const metadata = {
    fileId,
    shortId: shortId || null,
    albumId,
    capturedAt: Number(capturedAt) || Date.now(),
    updatedAt: Date.now(),
  };

  const writes = [];
  const assetKey = await assetIndexKey(clientAssetId);
  if (assetKey) writes.push(env.img_url.put(assetKey, '', { metadata }));

  const hashKey = contentHashIndexKey(contentHash);
  if (hashKey) writes.push(env.img_url.put(hashKey, '', { metadata }));

  await Promise.all(writes);
}

export async function removeDedupeIndexes(env, metadata = {}) {
  if (!env.img_url) return;
  const deletes = [];

  if (metadata.clientAssetId) {
    const key = await assetIndexKey(metadata.clientAssetId);
    if (key) deletes.push(env.img_url.delete(key));
  }

  if (metadata.contentHash) {
    const key = contentHashIndexKey(metadata.contentHash);
    if (key) deletes.push(env.img_url.delete(key));
  }

  await Promise.all(deletes);
}

export async function buildLegacyAssetIndex(env, fileId, metadata = {}) {
  const clientAssetId = normalizeClientAssetId(metadata.clientAssetId)
    || createLegacyClientAssetId(metadata);
  if (!clientAssetId) return { indexed: false, clientAssetId: '' };

  await saveDedupeIndexes(env, {
    clientAssetId,
    contentHash: metadata.contentHash || '',
    fileId,
    shortId: metadata.shortId || null,
    albumId: metadata.albumId || 'unclassified',
    capturedAt: metadata.capturedAt || metadata.TimeStamp || Date.now(),
  });

  return { indexed: true, clientAssetId };
}

async function readValidIndex(env, key) {
  const record = await env.img_url.getWithMetadata(key);
  const metadata = record?.metadata;
  if (!metadata?.fileId) return null;

  const fileRecord = await env.img_url.getWithMetadata(metadata.fileId);
  if (!fileRecord?.metadata) {
    await env.img_url.delete(key);
    return null;
  }

  return {
    ...metadata,
    fileId: metadata.fileId,
    shortId: fileRecord.metadata.shortId || metadata.shortId || null,
    albumId: fileRecord.metadata.albumId || metadata.albumId || 'unclassified',
    capturedAt: fileRecord.metadata.capturedAt || metadata.capturedAt || 0,
  };
}
