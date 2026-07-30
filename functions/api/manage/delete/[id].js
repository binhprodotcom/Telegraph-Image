import { jsonResponse } from '../../../utils/http.js';
import { getMetadata } from '../../../utils/metadata.js';
import { deleteShortLink } from '../../../utils/shortlink.js';
import { removeFileAlbumIndex } from '../../../utils/albums.js';
import { removeDedupeIndexes } from '../../../utils/dedupe.js';
import { deleteR2Object } from '../../../utils/storage.js';
import { deleteTelegramMessage } from '../../../utils/telegram.js';

export async function onRequest(context) {
  const { env, params } = context;
  const metadata = await getMetadata(env, params.id);

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
  await env.img_url.delete(params.id);
  if (metadata?.shortId) await deleteShortLink(env, metadata.shortId);

  return jsonResponse({
    id: params.id,
    r2Deleted: Boolean(metadata?.r2Key),
    telegramBackupRetained: Boolean(metadata?.telegramMessageId && !telegramDeleted),
    telegramDeleted,
  });
}
