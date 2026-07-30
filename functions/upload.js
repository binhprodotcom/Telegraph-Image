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
  deleteTelegramMessage,
  getFileId,
  getMessageId,
  getUploadTarget,
  sendToTelegram,
  validateTelegramConfig,
} from './utils/telegram.js';
import {
  createR2Identity,
  deleteR2Object,
  getStoragePlan,
  putR2Object,
  validateR2Binding,
} from './utils/storage.js';

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
  let r2Metadata = null;
  let telegramMessageId = null;
  let metadataSaved = false;

  try {
    const backupRequest = isValidBackupRequest(request, env);
    const authResponse = authenticateUploadRequest(request, env);
    if (authResponse && !backupRequest) return authResponse;

    const storagePlan = getStoragePlan(env);
    validateR2Binding(env, storagePlan);
    if (storagePlan.useTelegram) validateTelegramConfig(env);

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
      return jsonResponse({ error: 'File vượt quá giới hạn 20 MB khi bật Telegram backup.' }, { status: 413 });
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

    const fileName = uploadFile.name || `upload-${capturedAt}.jpg`;
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

    let publicId = '';
    let r2Object = null;

    if (storagePlan.useR2) {
      const identity = createR2Identity(fileName, capturedAt);
      publicId = identity.publicId;
      r2Object = await putR2Object(env, {
        key: identity.r2Key,
        file: uploadFile,
        contentHash,
        originalName: fileName,
        capturedAt,
      });
      r2Metadata = { r2Key: identity.r2Key };

      r2Metadata.r2Etag = r2Object.etag || '';
      r2Metadata.r2Version = r2Object.version || '';
    }

    let telegramLongId = '';
    let telegramStatus = storagePlan.useTelegram ? 'pending' : 'disabled';
    let telegramError = '';

    if (storagePlan.useTelegram) {
      const { endpoint, field } = getUploadTarget(uploadFile);
      const telegramFormData = createTelegramFormData(env.TG_Chat_ID, field, uploadFile);
      const result = await sendToTelegram(telegramFormData, endpoint, env);

      if (result.success) {
        const telegramFileId = getFileId(result.data);
        telegramMessageId = getMessageId(result.data);
        if (!telegramFileId) throw new Error('Telegram không trả về file ID.');

        telegramLongId = `${telegramFileId}.${fileExtension}`;
        telegramStatus = 'stored';

        if (!publicId) publicId = telegramLongId;
      } else {
        telegramStatus = 'failed';
        telegramError = result.error || 'Telegram backup thất bại.';

        // R2 remains the source of truth. Only fail when there is no R2 copy.
        if (!storagePlan.useR2) throw new Error(telegramError);
      }
    }

    if (!publicId) throw new Error('Không tạo được ID công khai cho file.');

    let shortId = null;
    if (env.img_url) {
      if (isShortUrlsEnabled(env)) shortId = await allocateShortId(env);

      const metadata = createDefaultMetadata(publicId, {
        fileName,
        fileSize: uploadFile.size,
        albumId: requestedAlbumId,
        capturedAt,
        capturedMonth: new Date(capturedAt).toISOString().slice(0, 7),
        clientAssetId,
        contentHash,
        uploadSource: backupRequest ? 'iphone-shortcut' : 'web',
        storageMode: storagePlan.mode,
        storagePrimary: storagePlan.useR2 ? 'r2' : 'telegram',
        r2Key: r2Metadata?.r2Key || '',
        r2Etag: r2Metadata?.r2Etag || '',
        r2Version: r2Metadata?.r2Version || '',
        telegramFileId: telegramLongId,
        telegramMessageId: telegramMessageId || 0,
        telegramStatus,
        telegramError: telegramError.slice(0, 500),
        ...(shortId ? { shortId } : {}),
      });

      await saveFileWithAlbumIndex(env, publicId, metadata);
      if (shortId) await putShortLink(env, shortId, publicId);
      await saveDedupeIndexes(env, {
        clientAssetId,
        contentHash,
        fileId: publicId,
        shortId,
        albumId: requestedAlbumId,
        capturedAt,
      });
      metadataSaved = true;
    }

    return jsonResponse([{
      src: `/file/${shortId || publicId}`,
      duplicate: false,
      storage: storagePlan.useR2 ? 'r2' : 'telegram',
      telegramBackup: telegramStatus === 'stored',
      ...(telegramError ? { warning: telegramError } : {}),
    }]);
  } catch (error) {
    console.error('Upload error:', error);

    if (!metadataSaved && r2Metadata?.r2Key) {
      try {
        await deleteR2Object(env, r2Metadata);
      } catch (cleanupError) {
        console.error('Unable to clean up R2 object:', cleanupError);
      }
    }

    if (!metadataSaved && telegramMessageId) {
      await deleteTelegramMessage(env, telegramMessageId);
    }

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
