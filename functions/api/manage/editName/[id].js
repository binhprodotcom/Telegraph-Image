import { jsonResponse, textResponse } from '../../../utils/http.js';
import { updateMetadata } from '../../../utils/metadata.js';
import { refreshFileAlbumIndex } from '../../../utils/albums.js';

export async function onRequest(context) {
  const { request, params, env } = context;
  const url = new URL(request.url);
  const fileName = url.searchParams.get('newName') || params.name;
  const metadata = await updateMetadata(env, params.id, current => {
    current.fileName = fileName;
    return current;
  });
  if (!metadata) {
    return textResponse(`Image metadata not found for ID: ${params.id}`, { status: 404 });
  }

  const synced = await refreshFileAlbumIndex(env, params.id, metadata);
  return jsonResponse({ success: true, fileName: synced.fileName, metadata: synced });
}
