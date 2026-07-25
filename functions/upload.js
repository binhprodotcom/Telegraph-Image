import { errorHandling, telemetryData } from './utils/middleware.js';
import { authenticateUploadRequest } from './utils/auth.js';
import { jsonResponse } from './utils/http.js';
import { createDefaultMetadata } from './utils/metadata.js';
import {
  UNCLASSIFIED_ALBUM_ID,
  albumExists,
  ensureDefaultAlbums,
  listAlbums,
  sanitizeAlbumId,
  saveFileWithAlbumIndex,
} from './utils/albums.js';
import { allocateShortId, isShortUrlsEnabled, putShortLink } from './utils/shortlink.js';
import {
  createTelegramFormData,
  getFileId,
  getUploadTarget,
  sendToTelegram,
  validateTelegramConfig,
} from './utils/telegram.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const authResponse = authenticateUploadRequest(request, env);
  if (authResponse) return authResponse;

  if (!env.img_url) {
    return jsonResponse({ albums: [], defaultAlbumId: UNCLASSIFIED_ALBUM_ID });
  }

  await ensureDefaultAlbums(env);
  return jsonResponse({
    albums: await listAlbums(env),
    defaultAlbumId: UNCLASSIFIED_ALBUM_ID,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const authResponse = authenticateUploadRequest(request, env);
    if (authResponse) return authResponse;

    validateTelegramConfig(env);

    const clonedRequest = request.clone();
    const formData = await clonedRequest.formData();

    await errorHandling(context);
    telemetryData(context);

    const uploadFile = formData.get('file');
    if (!uploadFile) throw new Error('No file uploaded');

    const requestedAlbumId = sanitizeAlbumId(formData.get('albumId') || UNCLASSIFIED_ALBUM_ID);
    if (env.img_url) {
      await ensureDefaultAlbums(env);
      if (!(await albumExists(env, requestedAlbumId))) {
        return jsonResponse({ error: 'Album không tồn tại.' }, { status: 400 });
      }
    }

    const capturedAtValue = Number(formData.get('capturedAt'));
    const capturedAt = Number.isFinite(capturedAtValue) && capturedAtValue > 0
      ? capturedAtValue
      : Date.now();

    const fileName = uploadFile.name;
    const fileExtension = fileName.split('.').pop().toLowerCase();
    const { endpoint, field } = getUploadTarget(uploadFile);
    const telegramFormData = createTelegramFormData(env.TG_Chat_ID, field, uploadFile);

    const result = await sendToTelegram(telegramFormData, endpoint, env);
    if (!result.success) throw new Error(result.error);

    const fileId = getFileId(result.data);
    if (!fileId) throw new Error('Failed to get file ID');

    const longId = `${fileId}.${fileExtension}`;
    let shortId = null;

    if (env.img_url) {
      if (isShortUrlsEnabled(env)) shortId = await allocateShortId(env);

      const metadata = createDefaultMetadata(longId, {
        fileName,
        fileSize: uploadFile.size,
        albumId: requestedAlbumId,
        capturedAt,
        capturedMonth: new Date(capturedAt).toISOString().slice(0, 7),
        ...(shortId ? { shortId } : {}),
      });

      await saveFileWithAlbumIndex(env, longId, metadata);
      if (shortId) await putShortLink(env, shortId, longId);
    }

    return jsonResponse([{ src: `/file/${shortId || longId}` }]);
  } catch (error) {
    console.error('Upload error:', error);
    return jsonResponse({ error: error.message }, { status: 500 });
  }
}
