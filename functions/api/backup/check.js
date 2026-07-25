import { authenticateBackupRequest } from '../../utils/backup-auth.js';
import { findDuplicateByClientAssetId, normalizeClientAssetId } from '../../utils/dedupe.js';
import { jsonResponse } from '../../utils/http.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const authResponse = authenticateBackupRequest(request, env);
  if (authResponse) return authResponse;

  if (!env.img_url) {
    return jsonResponse({ error: 'KV img_url chưa được kết nối.' }, { status: 503 });
  }

  const url = new URL(request.url);
  const assetId = normalizeClientAssetId(url.searchParams.get('assetId'));
  if (!assetId) return jsonResponse({ error: 'Thiếu assetId.' }, { status: 400 });

  const duplicate = await findDuplicateByClientAssetId(env, assetId);
  if (!duplicate) {
    return jsonResponse({ exists: false }, { headers: { 'Cache-Control': 'no-store' } });
  }

  return jsonResponse({
    exists: true,
    fileId: duplicate.fileId,
    shortId: duplicate.shortId || null,
    albumId: duplicate.albumId || 'unclassified',
    src: `/file/${duplicate.shortId || duplicate.fileId}`,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
