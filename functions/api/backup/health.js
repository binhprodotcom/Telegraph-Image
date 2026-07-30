import { authenticateBackupRequest } from '../../utils/backup-auth.js';
import { jsonResponse } from '../../utils/http.js';
import { getStoragePlan } from '../../utils/storage.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const authResponse = authenticateBackupRequest(request, env);
  if (authResponse) return authResponse;

  const plan = getStoragePlan(env);

  return jsonResponse({
    ok: true,
    kv: Boolean(env.img_url),
    r2: Boolean(env.IMAGE_BUCKET),
    telegram: Boolean(env.TG_Bot_Token && env.TG_Chat_ID),
    storageMode: plan.mode,
    dedupe: Boolean(env.img_url),
    timestamp: Date.now(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
