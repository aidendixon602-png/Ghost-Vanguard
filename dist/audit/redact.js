/**
 * Logs must never carry credentials. Anything that looks like a Discord token, an API key or a
 * "password=..." pair is masked before it is stored or posted (including message text that
 * members paste into chat).
 */
const PATTERNS = [
    // Discord bot/user tokens: base64 id . timestamp . hmac
    [/\b[MNO][A-Za-z\d_-]{22,27}\.[A-Za-z\d_-]{5,7}\.[A-Za-z\d_-]{25,}\b/g, '[token hidden]'],
    // OpenAI / Anthropic / generic "sk-" style secret keys
    [/\bsk-(?:proj-|ant-)?[A-Za-z\d_-]{16,}\b/g, '[key hidden]'],
    // Webhook URLs contain their own secret token
    [/https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/gi, '[webhook URL hidden]'],
    // key=value / key: value pairs that name a secret
    [/\b((?:api[_-]?key|token|secret|password|passwd|client[_-]?secret)\s*[:=]\s*)\S+/gi, '$1[hidden]'],
];
export function redact(text) {
    if (!text)
        return text;
    let out = text;
    for (const [pattern, replacement] of PATTERNS)
        out = out.replace(pattern, replacement);
    return out;
}
