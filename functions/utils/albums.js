const ALBUM_KEY_PREFIX = '__bbc_album__:';
const ALBUM_INDEX_PREFIX = '__bbc_album_index__:';
const SHORT_KEY_PREFIX = 'short:';
const ASSET_KEY_PREFIX = '__bbc_asset__:';
const HASH_KEY_PREFIX = '__bbc_hash__:';
const UNCLASSIFIED_ID = 'unclassified';
const MAX_TIMESTAMP = 9999999999999;

const DEFAULT_ALBUMS = [
  { id: 'personal', name: 'Cá nhân' },
  { id: 'family', name: 'Gia đình' },
  { id: 'otfvn', name: 'OTFVN' },
  { id: 'website', name: 'Website' },
  { id: 'temporary', name: 'Ảnh tạm' },
];

export const UNCLASSIFIED_ALBUM_ID = UNCLASSIFIED_ID;

export function sanitizeAlbumId(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || UNCLASSIFIED_ID;
}

export function normalizeAlbumName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 64);
}

export function isInternalStorageKey(name) {
  return typeof name === 'string' && (
    name.startsWith(ALBUM_KEY_PREFIX)
    || name.startsWith(ALBUM_INDEX_PREFIX)
    || name.startsWith(SHORT_KEY_PREFIX)
    || name.startsWith(ASSET_KEY_PREFIX)
    || name.startsWith(HASH_KEY_PREFIX)
  );
}

export function albumIndexPrefix(albumId) {
  return `${ALBUM_INDEX_PREFIX}${sanitizeAlbumId(albumId)}:`;
}

export function albumIndexKey(albumId, timestamp, fileId) {
  const safeTime = Math.max(0, Math.min(MAX_TIMESTAMP, Number(timestamp) || Date.now()));
  const reversed = String(MAX_TIMESTAMP - safeTime).padStart(13, '0');
  return `${albumIndexPrefix(albumId)}${reversed}:${encodeURIComponent(fileId)}`;
}

export async function ensureDefaultAlbums(env) {
  if (!env.img_url) return [];
  const current = await listAlbums(env);
  if (current.length > 0) return current;

  const now = Date.now();
  await Promise.all(DEFAULT_ALBUMS.map((album, index) => putAlbum(env, {
    ...album,
    createdAt: now + index,
    updatedAt: now + index,
  })));
  return listAlbums(env);
}

export async function listAlbums(env) {
  if (!env.img_url) return [];
  const result = await env.img_url.list({ prefix: ALBUM_KEY_PREFIX, limit: 1000 });
  const albums = await Promise.all(result.keys.map(async key => {
    const fallbackId = key.name.slice(ALBUM_KEY_PREFIX.length);
    let record = normalizeAlbumRecord(key.metadata, fallbackId);
    if (record) return record;

    try {
      const stored = await env.img_url.get(key.name, { type: 'json' });
      record = normalizeAlbumRecord(stored, fallbackId);
    } catch {
      record = null;
    }
    return record;
  }));

  return albums
    .filter(Boolean)
    .sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name, 'vi'));
}

export async function getAlbum(env, albumId) {
  const id = sanitizeAlbumId(albumId);
  if (id === UNCLASSIFIED_ID) {
    return { id, name: 'Chưa phân loại', virtual: true, createdAt: 0, updatedAt: 0 };
  }

  const key = ALBUM_KEY_PREFIX + id;
  let record = null;

  try {
    record = await env.img_url.getWithMetadata(key);
  } catch {
    record = null;
  }

  // Bản mới lưu album ở cả metadata và JSON value. Một số bản cũ chỉ
  // có một trong hai, vì vậy phải thử cả hai để tránh lỗi đổi tên 500.
  let album = normalizeAlbumRecord(record?.metadata, id);

  if (!album && record?.value) {
    try {
      album = normalizeAlbumRecord(JSON.parse(record.value), id);
    } catch {
      album = null;
    }
  }

  // KV có thể trả kết quả đọc riêng bị cũ trong khi list() đã nhìn thấy key.
  // Dùng danh sách làm lớp fallback cuối cùng.
  if (!album) {
    try {
      album = (await listAlbums(env)).find(item => item.id === id) || null;
    } catch {
      album = null;
    }
  }

  return album;
}

export async function albumExists(env, albumId) {
  const id = sanitizeAlbumId(albumId);
  if (id === UNCLASSIFIED_ID) return true;
  return Boolean(await getAlbum(env, id));
}

export async function createAlbum(env, name) {
  const normalizedName = normalizeAlbumName(name);
  if (!normalizedName) throw new Error('Tên album không được để trống.');

  const nameKey = normalizedName.toLocaleLowerCase('vi');
  const duplicate = (await listAlbums(env)).find(album =>
    normalizeAlbumName(album.name).toLocaleLowerCase('vi') === nameKey
  );
  if (duplicate) throw new Error(`Album “${duplicate.name}” đã tồn tại.`);

  const base = sanitizeAlbumId(normalizedName);
  let id = base;
  let counter = 2;
  while (await getAlbum(env, id)) {
    id = `${base}-${counter++}`.slice(0, 48);
  }

  const now = Date.now();
  const album = { id, name: normalizedName, createdAt: now, updatedAt: now };
  await putAlbum(env, album);
  return album;
}

export async function renameAlbum(env, albumId, name, fallback = {}) {
  const id = sanitizeAlbumId(albumId);
  if (id === UNCLASSIFIED_ID) throw new Error('Không thể đổi tên album Chưa phân loại.');

  let current = await getAlbum(env, id);

  // Khi album vừa được tạo/khởi tạo, KV có thể chưa đồng bộ lần đọc riêng.
  // Dashboard gửi kèm dữ liệu album hiện tại để thao tác đổi tên vẫn hoàn tất.
  if (!current) {
    const fallbackName = normalizeAlbumName(fallback.name);
    if (fallbackName) {
      const now = Date.now();
      current = {
        id,
        name: fallbackName,
        createdAt: Number(fallback.createdAt) || now,
        updatedAt: Number(fallback.updatedAt) || Number(fallback.createdAt) || now,
      };
    }
  }

  if (!current) throw new Error('Không tìm thấy album. Hãy làm mới trang rồi thử lại.');

  const normalizedName = normalizeAlbumName(name);
  if (!normalizedName) throw new Error('Tên album không được để trống.');

  const nameKey = normalizedName.toLocaleLowerCase('vi');
  const duplicate = (await listAlbums(env)).find(album =>
    album.id !== id && normalizeAlbumName(album.name).toLocaleLowerCase('vi') === nameKey
  );
  if (duplicate) throw new Error(`Đã có album tên “${duplicate.name}”.`);

  const updated = { ...current, id, name: normalizedName, updatedAt: Date.now() };
  await putAlbum(env, updated);
  return updated;
}

export async function deleteAlbumBatch(env, albumId, batchSize = 20) {
  const id = sanitizeAlbumId(albumId);
  if (id === UNCLASSIFIED_ID) throw new Error('Không thể xóa album Chưa phân loại.');
  const album = await getAlbum(env, id);
  if (!album) return { complete: true, moved: 0 };

  const page = await env.img_url.list({ prefix: albumIndexPrefix(id), limit: batchSize });
  let moved = 0;
  for (const key of page.keys) {
    const fileId = key.metadata?.fileId;
    if (!fileId) {
      await env.img_url.delete(key.name);
      continue;
    }
    const metadata = await getFileMetadata(env, fileId);
    if (!metadata) {
      await env.img_url.delete(key.name);
      continue;
    }
    await saveFileWithAlbumIndex(env, fileId, {
      ...metadata,
      albumId: UNCLASSIFIED_ID,
    }, key.name);
    moved += 1;
  }

  const remaining = await env.img_url.list({ prefix: albumIndexPrefix(id), limit: 1 });
  const complete = remaining.keys.length === 0;
  if (complete) await env.img_url.delete(ALBUM_KEY_PREFIX + id);
  return { complete, moved };
}

export async function getFileMetadata(env, fileId) {
  const record = await env.img_url.getWithMetadata(fileId);
  return record?.metadata || null;
}

export async function saveFileWithAlbumIndex(env, fileId, metadata, previousIndexKey = null) {
  const normalized = normalizeAlbumMetadata(metadata, fileId);
  const nextIndexKey = albumIndexKey(normalized.albumId, normalized.TimeStamp, fileId);
  const oldIndexKey = previousIndexKey || normalized.albumIndexKey || null;
  normalized.albumIndexKey = nextIndexKey;

  await env.img_url.put(fileId, '', { metadata: normalized });
  await env.img_url.put(nextIndexKey, '', { metadata: createIndexMetadata(fileId, normalized) });

  if (oldIndexKey && oldIndexKey !== nextIndexKey) {
    await env.img_url.delete(oldIndexKey);
  }
  return normalized;
}

export async function refreshFileAlbumIndex(env, fileId, metadata) {
  if (!metadata) return null;
  return saveFileWithAlbumIndex(env, fileId, metadata, metadata.albumIndexKey || null);
}

export async function moveFileToAlbum(env, fileId, albumId) {
  const target = sanitizeAlbumId(albumId);
  if (!(await albumExists(env, target))) throw new Error('Album đích không tồn tại.');
  const metadata = await getFileMetadata(env, fileId);
  if (!metadata) throw new Error(`Không tìm thấy metadata: ${fileId}`);
  return saveFileWithAlbumIndex(env, fileId, { ...metadata, albumId: target }, metadata.albumIndexKey || null);
}

export async function removeFileAlbumIndex(env, metadata) {
  if (metadata?.albumIndexKey) await env.img_url.delete(metadata.albumIndexKey);
}

export function normalizeAlbumMetadata(metadata = {}, fileId = '') {
  const timestamp = Number(metadata.TimeStamp) || Date.now();
  const capturedAt = Number(metadata.capturedAt) || timestamp;
  return {
    ...metadata,
    TimeStamp: timestamp,
    albumId: sanitizeAlbumId(metadata.albumId || UNCLASSIFIED_ID),
    capturedAt,
    capturedMonth: metadata.capturedMonth || monthFromTimestamp(capturedAt),
    tags: Array.isArray(metadata.tags) ? metadata.tags.slice(0, 20) : [],
    fileName: metadata.fileName || fileId,
  };
}

function createIndexMetadata(fileId, metadata) {
  return {
    fileId,
    TimeStamp: metadata.TimeStamp,
    ListType: metadata.ListType,
    Label: metadata.Label,
    liked: metadata.liked,
    fileName: metadata.fileName,
    fileSize: metadata.fileSize,
    shortId: metadata.shortId,
    albumId: metadata.albumId,
    capturedAt: metadata.capturedAt,
    capturedMonth: metadata.capturedMonth,
    tags: metadata.tags,
  };
}

async function putAlbum(env, album) {
  const normalized = normalizeAlbumRecord(album, album.id);
  await env.img_url.put(ALBUM_KEY_PREFIX + normalized.id, JSON.stringify(normalized), { metadata: normalized });
}

function normalizeAlbumRecord(value, fallbackId) {
  if (!value || typeof value !== 'object') return null;
  const id = sanitizeAlbumId(value.id || fallbackId);
  if (!id || id === UNCLASSIFIED_ID) return null;
  const name = normalizeAlbumName(value.name);
  if (!name) return null;
  return {
    id,
    name,
    createdAt: Number(value.createdAt) || Date.now(),
    updatedAt: Number(value.updatedAt) || Number(value.createdAt) || Date.now(),
  };
}

function monthFromTimestamp(timestamp) {
  try {
    return new Date(timestamp).toISOString().slice(0, 7);
  } catch {
    return '';
  }
}
