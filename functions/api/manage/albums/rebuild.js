import { jsonResponse } from '../../../utils/http.js';
import {
  isInternalStorageKey,
  normalizeAlbumMetadata,
  saveFileWithAlbumIndex,
} from '../../../utils/albums.js';

export async function onRequestPost({ request, env }) {
  let body = {};
  try { body = await request.json(); } catch {}

  const cursor = body.cursor || undefined;
  const result = await env.img_url.list({ limit: 50, cursor });
  let indexed = 0;

  for (const key of result.keys) {
    if (isInternalStorageKey(key.name)) continue;
    let metadata = key.metadata;
    if (!metadata) {
      const record = await env.img_url.getWithMetadata(key.name);
      metadata = record?.metadata;
    }
    if (!metadata) continue;

    const normalized = normalizeAlbumMetadata(metadata, key.name);
    await saveFileWithAlbumIndex(env, key.name, normalized, normalized.albumIndexKey || null);
    indexed += 1;
  }

  return jsonResponse({
    indexed,
    complete: result.list_complete,
    cursor: result.list_complete ? null : result.cursor,
  });
}
