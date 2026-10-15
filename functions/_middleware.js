/**
 * DFVN private UI gate for Cloudflare Pages.
 * Install at functions/_middleware.js on branch dfvn.
 * Protects HTML/static UI; deliberately does NOT change existing API authentication.
 */

const COOKIE_NAME = 'dfvn_ui_session';
const SESSION_SECONDS = 8 * 60 * 60;
const encoder = new TextEncoder();

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // Keep all existing image links and API endpoints exactly as they are.
  // API authentication continues to be enforced by the existing route handlers.
  if (
    path === '/upload' || path === '/upload/' ||
    path.startsWith('/api/') ||
    path === '/file' || path.startsWith('/file/') ||
    path === '/favicon.ico' || path === '/bg.svg' || path === '/robots.txt'
  ) {
    return context.next();
  }

  // A private login form, not a copy of the existing upload/admin HTML.
  if (path === '/private-login') {
    if (request.method === 'GET' || request.method === 'HEAD') {
      return loginPage('', safeDestination(url.searchParams.get('next')));
    }
    if (request.method === 'POST') {
      return handleLogin(request, env);
    }
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD, POST' } });
  }

  // Log out using a POST form, so a third-party link cannot sign the user out.
  if (path === '/private-logout') {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
    }
    if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });
    return redirectTo('/private-login', `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  }

  // Protect every other path by default. This covers /, /index.html,
  // /admin, /admin.html and potential Pages pretty-URL / SPA fallbacks.
  // Public /file/* links are explicitly exempted above.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return context.next();
  }

  if (!isSecretConfigured(env)) {
    return new Response('Missing DFVN_SESSION_SECRET (must be at least 32 characters).', {
      status: 503, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }

  const session = await readSession(request, env);
  const adminPage = /^\/admin(?:\.html)?\/?$/i.test(path);
  if (!session || (adminPage && session.role !== 'admin')) {
    const destination = adminPage ? '/admin.html' : '/';
    return redirectTo(`/private-login?next=${encodeURIComponent(destination)}`);
  }

  const response = await context.next();
  const secured = new Response(response.body, response);
  secured.headers.set('Cache-Control', 'private, no-store');
  secured.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return secured;
}

async function handleLogin(request, env) {
  if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });
  if (!isSecretConfigured(env)) return new Response('Missing login secret.', { status: 503 });

  const contentLength = Number(request.headers.get('content-length') || '0');
  if (contentLength > 8192) return new Response('Request too large', { status: 413 });
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    return new Response('Unsupported content type', { status: 415 });
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return loginPage('Dữ liệu đăng nhập không hợp lệ.', '/', 400);
  }

  const username = String(form.get('username') || '');
  const password = String(form.get('password') || '');
  const next = safeDestination(form.get('next'));
  if (username.length > 128 || password.length > 1024) {
    return loginPage('Tên đăng nhập hoặc mật khẩu không đúng.', next, 401);
  }

  let role = null;
  if (
    env.BASIC_USER && env.BASIC_PASS &&
    username === env.BASIC_USER && password === env.BASIC_PASS
  ) {
    role = 'admin';
  } else if (
    env.UPLOAD_BASIC_USER && env.UPLOAD_BASIC_PASS &&
    username === env.UPLOAD_BASIC_USER && password === env.UPLOAD_BASIC_PASS
  ) {
    role = 'upload';
  }
  if (!role) return loginPage('Tên đăng nhập hoặc mật khẩu không đúng.', next, 401);
  if (next === '/admin.html' && role !== 'admin') {
    return loginPage('Trang quản trị yêu cầu tài khoản Admin.', next, 403);
  }

  const token = await issueSession(role, env);
  const cookie = `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
  return redirectTo(next, cookie, 303);
}

function safeDestination(input) {
  return input === '/admin.html' ? '/admin.html' : '/';
}

function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  return origin === new URL(request.url).origin;
}

function isSecretConfigured(env) {
  return typeof env.DFVN_SESSION_SECRET === 'string' && env.DFVN_SESSION_SECRET.length >= 32;
}

async function signingKey(env) {
  return crypto.subtle.importKey(
    'raw', encoder.encode(env.DFVN_SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

function toBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(decoded, char => char.charCodeAt(0));
}

async function issueSession(role, env) {
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const payload = `v1.${role}.${expires}.${nonce}`;
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(env), encoder.encode(payload)));
  return `${payload}.${toBase64Url(signature)}`;
}

async function readSession(request, env) {
  const cookies = request.headers.get('Cookie') || '';
  const match = cookies.match(/(?:^|;\s*)dfvn_ui_session=([^;]+)/);
  if (!match) return null;
  const parts = match[1].split('.');
  if (parts.length !== 5) return null;
  const [version, role, expiresText, nonce, signatureText] = parts;
  if (version !== 'v1' || !['admin', 'upload'].includes(role)) return null;
  if (!/^\d{10}$/.test(expiresText) || !/^[0-9a-f]{32}$/.test(nonce)) return null;
  const expires = Number(expiresText);
  const now = Math.floor(Date.now() / 1000);
  if (expires <= now || expires > now + SESSION_SECONDS) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(signatureText)) return null;
  const payload = `${version}.${role}.${expiresText}.${nonce}`;
  try {
    const valid = await crypto.subtle.verify(
      'HMAC', await signingKey(env), fromBase64Url(signatureText), encoder.encode(payload)
    );
    return valid ? { role } : null;
  } catch {
    return null;
  }
}

function redirectTo(path, cookie, status = 302) {
  const headers = new Headers({
    Location: path, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow'
  });
  if (cookie) headers.set('Set-Cookie', cookie);
  return new Response(null, { status, headers });
}

function loginPage(error, destination, status = 200) {
  const message = error ? `<p class="error" role="alert">${error}</p>` : '';
  const admin = destination === '/admin.html';
  const heading = admin ? 'Đăng nhập quản trị' : 'Đăng nhập DFVN Image';
  const html = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading} · DFVN Image</title><meta name="robots" content="noindex,nofollow">
<style>
:root{color-scheme:dark;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:22px;color:#f7f2e9;
background:radial-gradient(circle at 20% 5%,#34281c 0,transparent 42%),#101010}
main{width:min(100%,440px);padding:clamp(28px,5vw,44px);border:1px solid #38332c;border-radius:28px;
background:#191919;box-shadow:0 28px 90px #0008}.icon{width:56px;height:56px;display:grid;place-items:center;
border:1px solid #85653b;border-radius:17px;background:#f4b65c19;color:#f4b65c;font-size:24px}
h1{font-size:clamp(28px,5vw,38px);line-height:1.12;letter-spacing:-.045em;margin:28px 0 10px}
p{line-height:1.6;color:#aaa4a0;margin:0 0 25px}label{font-size:14px;font-weight:650;display:block;margin:18px 0 9px}
input{width:100%;padding:15px 16px;border:1px solid #494949;border-radius:12px;background:#252525;color:white;font:inherit}
input:focus{outline:2px solid #f4b65c;outline-offset:2px}button{width:100%;margin-top:25px;padding:16px 14px;
border:0;border-radius:999px;background:#f4b65c;color:#21170b;font-size:16px;font-weight:760;cursor:pointer}
.error{margin:0 0 16px;padding:12px;border:1px solid #9f3838;border-radius:10px;color:#ff9494;background:#441f1f}
small{display:block;text-align:center;margin-top:20px;color:#8c8580}
</style></head><body><main><div class="icon" aria-hidden="true">&#128274;</div>
<h1>${heading}</h1><p>Kho lưu trữ ảnh riêng. Vui lòng đăng nhập để tiếp tục.</p>${message}
<form method="post" action="/private-login" autocomplete="on">
<input type="hidden" name="next" value="${destination}">
<label for="username">Tên đăng nhập</label><input id="username" name="username" autocomplete="username" maxlength="128" required autofocus>
<label for="password">Mật khẩu</label><input id="password" type="password" name="password" autocomplete="current-password" required>
<button type="submit">Đăng nhập</button></form><small>DFVN Image · Private Storage</small>
</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    }
  });
}
