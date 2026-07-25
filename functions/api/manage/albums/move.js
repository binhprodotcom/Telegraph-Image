import { jsonResponse } from '../../../utils/http.js';
import { albumExists, moveFileToAlbum, sanitizeAlbumId } from '../../../utils/albums.js';

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const albumId = sanitizeAlbumId(body.albumId);
  const fileIds = Array.isArray(body.fileIds)
    ? [...new Set(body.fileIds.map(String).filter(Boolean))].slice(0, 50)
    : [];

  if (fileIds.length === 0) {
    return jsonResponse({ error: 'Chưa chọn file.' }, { status: 400 });
  }
  if (!(await albumExists(env, albumId))) {
    return jsonResponse({ error: 'Album đích không tồn tại.' }, { status: 404 });
  }

  const results = [];
  for (const fileId of fileIds) {
    try {
      const metadata = await moveFileToAlbum(env, fileId, albumId);
      results.push({ fileId, success: true, metadata });
    } catch (error) {
      results.push({ fileId, success: false, error: error.message });
    }
  }

  return jsonResponse({ results });
}
