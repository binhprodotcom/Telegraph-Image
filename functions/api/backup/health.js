import { authenticateBackupRequest } from '../../utils/backup-auth.js';
import { jsonResponse } from '../../utils/http.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const authResponse = authenticateBackupRequest(request, env);
  if (authResponse) return authResponse;

  return jsonResponse({
    ok: true,
    kv: Boolean(env.img_url),
    telegram: Boolean(env.TG_Bot_Token && env.TG_Chat_ID),
    dedupe: Boolean(env.img_url),
    timestamp: Date.now(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
