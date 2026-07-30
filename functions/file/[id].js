import {
    getOrCreateMetadata,
    isBlocked,
    isWhitelisted,
    putMetadata,
} from "../utils/metadata.js";
import { getTelegramFilePath } from "../utils/telegram.js";
import { getR2Response } from "../utils/storage.js";
import { isShortUrlsEnabled, looksLikeShortId, resolveShortId } from "../utils/shortlink.js";

export async function onRequest(context) {
    const { request, env, params } = context;
    const url = new URL(request.url);
    const fileId = await resolveRequestedId(env, params.id);
    const isAdmin = request.headers.get('Referer')?.includes(`${url.origin}/admin`);

    let metadata = null;
    if (env.img_url) metadata = await getOrCreateMetadata(env, fileId);

    if (!isAdmin && metadata) {
        if (isBlocked(metadata)) {
            const referer = request.headers.get('Referer');
            const redirectUrl = referer
                ? "https://static-res.pages.dev/teleimage/img-block-compressed.png"
                : `${url.origin}/block-img.html`;
            return Response.redirect(redirectUrl, 302);
        }

        if (!isWhitelisted(metadata) && env.WhiteList_Mode === "true") {
            return Response.redirect(`${url.origin}/whitelist-on.html`, 302);
        }
    }

    // R2 is the primary source for new dual-storage records.
    if (metadata?.r2Key) {
        try {
            const r2Response = await getR2Response(env, request, metadata, fileId);
            if (r2Response) return withFileHeaders(r2Response, metadata.fileName || fileId);
            console.warn(`R2 object not found for ${fileId}; falling back to Telegram.`);
        } catch (error) {
            console.error(`R2 read failed for ${fileId}:`, error);
        }
    }

    const fileUrl = await resolveLegacyFileUrl(env, url, fileId, metadata);
    if (!fileUrl) {
        return new Response('File not found in R2 or Telegram backup.', {
            status: 404,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
    }

    const response = await fetch(fileUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
    });

    if (!response.ok) return response;
    if (isAdmin || !env.img_url) return withFileHeaders(response, metadata?.fileName || fileId);

    const effectiveMetadata = metadata || await getOrCreateMetadata(env, fileId);

    if (isWhitelisted(effectiveMetadata)) {
        return withFileHeaders(response, effectiveMetadata.fileName || fileId);
    }

    const moderationResult = await moderateFile(env, url, fileId, effectiveMetadata);
    if (moderationResult.blocked) {
        await putMetadata(env, fileId, effectiveMetadata);
        return Response.redirect(`${url.origin}/block-img.html`, 302);
    }

    await putMetadata(env, fileId, effectiveMetadata);
    return withFileHeaders(response, effectiveMetadata.fileName || fileId);
}

async function resolveRequestedId(env, requestedId) {
    if (!env.img_url || !isShortUrlsEnabled(env) || requestedId.includes('.') || !looksLikeShortId(requestedId)) {
        return requestedId;
    }

    const target = await resolveShortId(env, requestedId);
    return target || requestedId;
}

async function resolveLegacyFileUrl(env, url, fileId, metadata) {
    const telegramId = metadata?.telegramFileId || fileId;

    if (telegramId.length > 33) {
        if (!env.TG_Bot_Token) return null;
        const rawId = telegramId.split(".")[0];
        const filePath = await getTelegramFilePath(env, rawId);
        if (!filePath) return null;
        return `https://api.telegram.org/file/bot${env.TG_Bot_Token}/${filePath}`;
    }

    // Legacy Telegraph file.
    if (!metadata?.r2Key) {
        return 'https://telegra.ph//file/' + telegramId + url.search;
    }

    return null;
}

async function moderateFile(env, url, fileId, metadata) {
    if (!env.ModerateContentApiKey || metadata?.r2Key) {
        return { blocked: false };
    }

    try {
        const moderateUrl = `https://api.moderatecontent.com/moderate/?key=${env.ModerateContentApiKey}&url=https://telegra.ph/file/${fileId}${url.search}`;
        const moderateResponse = await fetch(moderateUrl);
        if (!moderateResponse.ok) return { blocked: false };

        const moderateData = await moderateResponse.json();
        if (moderateData?.rating_label) metadata.Label = moderateData.rating_label;
        return { blocked: isBlocked(metadata) };
    } catch (error) {
        console.error("Error during content moderation: " + error.message);
        return { blocked: false };
    }
}

function withFileHeaders(response, filename) {
    const upstreamType = response.headers.get('Content-Type') || '';
    const correctedType = isUsableContentType(upstreamType) ? null : contentTypeFromFilename(filename);
    const effectiveType = correctedType || upstreamType;
    const inline = isPreviewableContent(effectiveType) || isPreviewableFilename(filename);

    if (!correctedType && !inline) return response;

    const headers = new Headers(response.headers);
    if (correctedType) headers.set('Content-Type', correctedType);
    if (inline) headers.set('Content-Disposition', `inline; filename="${escapeFilename(filename)}"`);

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

function isUsableContentType(contentType) {
    return contentType !== '' && !contentType.startsWith('application/octet-stream');
}

const CONTENT_TYPES_BY_EXTENSION = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    apng: 'image/apng',
    heic: 'image/heic',
    heif: 'image/heif',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    mp4: 'video/mp4',
    m4v: 'video/x-m4v',
    mov: 'video/quicktime',
    webm: 'video/webm',
    ogv: 'video/ogg',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    aac: 'audio/aac',
    pdf: 'application/pdf',
};

function contentTypeFromFilename(filename) {
    const extension = String(filename).split('.').pop().toLowerCase();
    return CONTENT_TYPES_BY_EXTENSION[extension] || null;
}

function isPreviewableContent(contentType) {
    return contentType.startsWith('image/')
        || contentType.startsWith('video/')
        || contentType.startsWith('audio/')
        || contentType.startsWith('application/pdf');
}

function isPreviewableFilename(filename) {
    return /\.(?:avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|webp|apng|mp4|m4v|mov|webm|ogv|mp3|m4a|ogg|oga|wav|flac|aac|pdf)$/i.test(String(filename));
}

function escapeFilename(filename) {
    return String(filename).replace(/["\\]/g, '_');
}
