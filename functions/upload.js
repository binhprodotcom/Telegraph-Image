import { errorHandling, telemetryData } from './utils/middleware.js';
import { authenticateUploadRequest } from './utils/auth.js';
import { isValidBackupRequest } from './utils/backup-auth.js';
import {
  contentHashForFile,
  createLegacyClientAssetId,
  findDuplicateByClientAssetId,
  findDuplicateByContentHash,
  normalizeClientAssetId,
  saveDedupeIndexes,
} from './utils/dedupe.js';
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

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

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
    const backupRequest = isValidBackupRequest(request, env);
    const authResponse = authenticateUploadRequest(request, env);
    if (authResponse && !backupRequest) return authResponse;

    validateTelegramConfig(env);
    if (!env.img_url && backupRequest) {
      return jsonResponse({ error: 'Backup tự động yêu cầu KV img_url.' }, { status: 503 });
    }

    const clonedRequest = request.clone();
    const formData = await clonedRequest.formData();

    await errorHandling(context);
    telemetryData(context);

    const uploadFile = formData.get('file');
    if (!uploadFile || typeof uploadFile.arrayBuffer !== 'function') {
      return jsonResponse({ error: 'Không có file hợp lệ.' }, { status: 400 });
    }
    if (uploadFile.size > MAX_UPLOAD_BYTES) {
      return jsonResponse({ error: 'File vượt quá giới hạn 20 MB.' }, { status: 413 });
    }

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

    const fileName = uploadFile.name || `iphone-${capturedAt}.jpg`;
    const fileExtension = (fileName.includes('.') ? fileName.split('.').pop() : 'jpg').toLowerCase();
    const suppliedClientAssetId = normalizeClientAssetId(formData.get('clientAssetId'));
    const clientAssetId = suppliedClientAssetId || createLegacyClientAssetId({
      fileName,
      fileSize: uploadFile.size,
      capturedAt,
    });

    if (env.img_url && clientAssetId) {
      const duplicate = await findDuplicateByClientAssetId(env, clientAssetId);
      if (duplicate) return duplicateResponse(duplicate, 'asset');
    }

    const contentHash = env.img_url ? await contentHashForFile(uploadFile) : '';
    if (env.img_url && contentHash) {
      const duplicate = await findDuplicateByContentHash(env, contentHash);
      if (duplicate) {
        await saveDedupeIndexes(env, {
          clientAssetId,
          contentHash,
          fileId: duplicate.fileId,
          shortId: duplicate.shortId,
          albumId: duplicate.albumId,
          capturedAt: duplicate.capturedAt || capturedAt,
        });
        return duplicateResponse(duplicate, 'content');
      }
    }

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
        clientAssetId,
        contentHash,
        uploadSource: backupRequest ? 'iphone-shortcut' : 'web',
        ...(shortId ? { shortId } : {}),
      });

      await saveFileWithAlbumIndex(env, longId, metadata);
      if (shortId) await putShortLink(env, shortId, longId);
      await saveDedupeIndexes(env, {
        clientAssetId,
        contentHash,
        fileId: longId,
        shortId,
        albumId: requestedAlbumId,
        capturedAt,
      });
    }

    return jsonResponse([{ src: `/file/${shortId || longId}`, duplicate: false }]);
  } catch (error) {
    console.error('Upload error:', error);
    return jsonResponse({ error: error.message }, { status: 500 });
  }
}

function duplicateResponse(duplicate, reason) {
  return jsonResponse([{
    src: `/file/${duplicate.shortId || duplicate.fileId}`,
    duplicate: true,
    reason,
    fileId: duplicate.fileId,
    albumId: duplicate.albumId || 'unclassified',
  }], { headers: { 'Cache-Control': 'no-store' } });
}
