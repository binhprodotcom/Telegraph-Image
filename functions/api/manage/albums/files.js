import { jsonResponse } from '../../../utils/http.js';
import { albumExists, albumIndexPrefix, sanitizeAlbumId } from '../../../utils/albums.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const albumId = sanitizeAlbumId(url.searchParams.get('albumId'));
  if (!(await albumExists(env, albumId))) {
    return jsonResponse({ error: 'Album không tồn tại.' }, { status: 404 });
  }

  let limit = parseInt(url.searchParams.get('limit') || '24', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 24;
  limit = Math.min(limit, 100);

  const cursor = url.searchParams.get('cursor') || undefined;
  const result = await env.img_url.list({
    prefix: albumIndexPrefix(albumId),
    limit,
    cursor,
  });

  return jsonResponse({
    ...result,
    keys: result.keys
      .filter(key => key.metadata?.fileId)
      .map(key => ({ name: key.metadata.fileId, metadata: key.metadata })),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
