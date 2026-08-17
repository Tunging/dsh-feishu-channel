/**
 * Pure, dependency-free helpers for the Feishu surface (no cordis/lark imports),
 * so they can be unit-tested in isolation.
 * @module @you/dsh-feishu/utils
 */
import { createHash } from "node:crypto";
/** Extract the plain-text content of an assistant message. */
export function assistantText(message) {
	return (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Split long text into fixed-size chunks. */
export function chunkText(text, max) {
	const out = [];
	for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
	return out.length ? out : [""];
}
/** A conservative markdown detector — enough to choose post(md) vs plain text. */
export function looksLikeMarkdown(text) {
	return /(^|\n)\s*(#{1,6}\s|[-*]\s|\d+\.\s|>|```|`[^`]+\`)|\*\*[^*]+\*\*|__[^_]+__|\!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(text);
}
/** Strip markdown down to plain text (for fallback delivery). */
export function stripMarkdown(text) {
	return text
		.replace(/```[^`]*```/gs, (m) => m.replace(/```/g, ""))
		.replace(/`([^`]+)`/g, "$1")
		.replace(/!\[[^\]]*\]\(([^)]+)\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^\s*([-*]|\d+\.)\s+/gm, "")
		.replace(/^\s*>\s?/gm, "")
		.replace(/(\*\*|__|~~|`)/g, "")
		.replace(/^\s+|\s+$/g, "");
}
/** Feishu webhook signature: base64(sha256(timestamp + nonce + encryptKey + body)). */
export function computeSignature(encryptKey, timestamp, nonce, body) {
	return createHash("sha256").update(`${timestamp}${nonce}${encryptKey}${body}`).digest("base64");
}
/** Constant-time signature comparison (hashes both sides to equalize length). */
export function timingSafeEqual(a, b) {
	const ha = createHash("sha256").update(String(a)).digest();
	const hb = createHash("sha256").update(String(b)).digest();
	return ha.equals(hb);
}
/** A simple sliding-window per-key rate limiter. */
export function makeRateLimiter(maxPerWindow, windowMs, maxKeys = 4096) {
	const counts = new Map();
	return function allow(key) {
		const now = Date.now();
		const entry = counts.get(key);
		if (entry === void 0) {
			if (counts.size >= maxKeys) return false;
			counts.set(key, { count: 1, start: now });
			return true;
		}
		if (now - entry.start >= windowMs) {
			entry.count = 1;
			entry.start = now;
			return true;
		}
		entry.count += 1;
		return entry.count <= maxPerWindow;
	};
}
