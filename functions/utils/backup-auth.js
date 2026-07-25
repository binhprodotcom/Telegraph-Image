export function authenticateBackupRequest(request, env) {
  const expected = String(env.BACKUP_TOKEN || '').trim();
  if (!expected) {
    return new Response(JSON.stringify({ error: 'BACKUP_TOKEN chưa được cấu hình.' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  const authorization = request.headers.get('Authorization') || '';
  const prefix = 'Bearer ';
  const provided = authorization.startsWith(prefix) ? authorization.slice(prefix.length) : '';

  if (!safeEqual(provided, expected)) {
    return new Response(JSON.stringify({ error: 'Backup token không hợp lệ.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  return null;
}

export function isValidBackupRequest(request, env) {
  return authenticateBackupRequest(request, env) === null;
}

function safeEqual(a, b) {
  const left = new TextEncoder().encode(String(a || ''));
  const right = new TextEncoder().encode(String(b || ''));
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] || 0) ^ (right[index] || 0);
  }
  return diff === 0;
}
