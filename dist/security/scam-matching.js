import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';
import sharp from 'sharp';
// The scanner never needs SVG; block the decoder even for disguised attachment names.
sharp.block({ operation: ['VipsForeignLoadSvg'] });
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 8000000;
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function fingerprint(bytes) {
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
        throw new Error('Image must be at most 8 MiB.');
    const image = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, pages: 1, failOn: 'warning' }).timeout({ seconds: 5 });
    const meta = await image.metadata();
    if (!['png', 'jpeg', 'webp'].includes(meta.format ?? '') || !meta.width || !meta.height || (meta.pages ?? 1) > 1)
        throw new Error('Use a static PNG, JPEG or WebP image.');
    // Full decoded pixels distinguish actual copies from visual approximations.
    const raw = await image.clone().rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixels = digest(Buffer.concat([Buffer.from(`${raw.info.width}:${raw.info.height}:`), raw.data]));
    const small = await image.clone().rotate().flatten({ background: '#ffffff' }).resize(9, 8, { fit: 'fill' }).greyscale().raw().toBuffer();
    let bits = 0n;
    for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++)
            bits = (bits << 1n) | (small[y * 9 + x] > small[y * 9 + x + 1] ? 1n : 0n);
    return { sha: digest(bytes), pixels, dhash: bits.toString(16).padStart(16, '0'), aspect: raw.info.width / raw.info.height };
}
export function imageMatch(a, b) {
    if (a.sha === b.sha || a.pixels === b.pixels)
        return 'confirmed';
    if (!/^[a-f0-9]{16}$/.test(a.dhash) || !/^[a-f0-9]{16}$/.test(b.dhash) || Math.abs(Math.log(a.aspect / b.aspect)) > .12)
        return null;
    let diff = BigInt(`0x${a.dhash}`) ^ BigInt(`0x${b.dhash}`), count = 0;
    while (diff) {
        diff &= diff - 1n;
        count++;
    }
    return count <= 6 ? 'similar' : null;
}
export function domain(value) {
    const text = value.trim().toLowerCase();
    if (/[\s/@:#?\\]/.test(text))
        throw new Error('Enter a domain only, such as scam.example.com.');
    const ascii = domainToASCII(text.replace(/\.$/, ''));
    if (!ascii || ascii.length > 253 || !ascii.includes('.') || ascii.split('.').some(p => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p)))
        throw new Error('Invalid domain.');
    return ascii;
}
/** Undo common link disguises: fullwidth/ideographic dots, invisible characters and Markdown escapes. */
export function normalizeLinks(text) {
    return text.normalize('NFKC').replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, '').replace(/[\u3002\uff0e\uff61]/g, '.').replace(/\\(?=[./:])/g, '');
}
export function blockedDomain(text, blocked) {
    if (!blocked.length)
        return null;
    // Read URL hosts, never substrings in paths or userinfo. Bare domains are supported.
    const tokens = normalizeLinks(text).match(/(?:https?:\/\/)?(?:[a-z0-9\u0080-\uffff-]+\.)+[a-z\u0080-\uffff]{2,}(?::\d+)?(?:[^\s<>`"']*)?/gi) ?? [];
    for (const token of tokens) {
        try {
            const clean = token.replace(/[),.!?;]+$/g, '');
            const host = new URL(/^https?:\/\//i.test(clean) ? clean : `https://${clean}`).hostname.replace(/\.$/, '').toLowerCase();
            const hit = blocked.find(d => host === d || host.endsWith(`.${d}`));
            if (hit)
                return hit;
        }
        catch { }
    }
    return null;
}
export function suspiciousText(value) {
    const text = value.normalize('NFKC').replace(/[\u200b-\u200f\u2060\ufeff]/g, '').toLowerCase();
    return /mr\s*beast/.test(text) && /crypto|casino/.test(text) && /giveaway|promo|\$\s*5[,.]?000|withdraw|claim.{0,30}(reward|money)/.test(text)
        || /(?:free|giveaway|claim).{0,40}nitro/.test(text) && /https?:\/\/|discord\.gift/.test(text);
}
export function attachmentUrl(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) || url.username || url.password || url.port || !/^\/(?:attachments|ephemeral-attachments)\//.test(url.pathname))
        throw new Error('Only Discord attachment URLs are accepted.');
    return url;
}
export async function downloadImage(url, size, fetcher = fetch) {
    attachmentUrl(url);
    if (!Number.isFinite(size) || size <= 0 || size > MAX_IMAGE_BYTES)
        throw new Error('Image exceeds the 8 MiB limit.');
    const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok || !response.body)
        throw new Error('Discord attachment download failed.');
    if (Number(response.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES)
        throw new Error('Image exceeds the 8 MiB limit.');
    const reader = response.body.getReader(), chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            total += value.byteLength;
            if (total > MAX_IMAGE_BYTES)
                throw new Error('Image exceeds the 8 MiB limit.');
            chunks.push(Buffer.from(value));
        }
    }
    finally {
        await reader.cancel().catch(() => { });
    }
    return Buffer.concat(chunks);
}
