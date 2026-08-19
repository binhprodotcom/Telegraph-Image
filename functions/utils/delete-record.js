import { getMetadata } from './metadata.js';
import { deleteShortLink } from './shortlink.js';
import { removeFileAlbumIndex } from './albums.js';
import { removeDedupeIndexes } from './dedupe.js';
import { deleteR2Object } from './storage.js';
import { deleteTelegramMessage } from './telegram.js';

export async function deleteManagedRecord(env, rawId) {
  const id = normalizeRecordId(rawId);
  if (!id) {
    throw new Error('Thiếu ID bản ghi cần xóa.');
  }

  const metadata = await getMetadata(env, id);

  if (metadata?.r2Key) {
    await deleteR2Object(env, metadata);
  }

  let telegramDeleted = false;
  if (
    env.DELETE_TELEGRAM_BACKUP_ON_DELETE === 'true'
    && metadata?.telegramMessageId
  ) {
    telegramDeleted = await deleteTelegramMessage(env, metadata.telegramMessageId);
  }

  await removeFileAlbumIndex(env, metadata);
  await removeDedupeIndexes(env, metadata);
  await env.img_url.delete(id);
  if (metadata?.shortId) await deleteShortLink(env, metadata.shortId);

  return {
    id,
    r2Deleted: Boolean(metadata?.r2Key),
    telegramBackupRetained: Boolean(metadata?.telegramMessageId && !telegramDeleted),
    telegramDeleted,
  };
}

function normalizeRecordId(value) {
  const id = String(value ?? '');
  if (!id || id.length > 1024 || /[\r\n\0]/.test(id)) return '';
  return id;
}
