/**
 * Pure, dependency-free helpers for the Feishu surface (no cordis/lark imports),
 * so they can be unit-tested in isolation.
 * @module @hiker8668/dsh-feishu/utils
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
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
/** Sanitize a filename for safe local storage (strip path separators/control chars). */
export function sanitizeFilename(name) {
	const base = String(name ?? "file").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
	return base || "file";
}
/**
 * Extract markdown media references from assistant text. Returns the text with
 * the extracted references removed plus a list of `{ kind, path, name }`.
 * Only local file paths (not http(s) URLs) are treated as media. When `exists`
 * is provided, a reference is only extracted (and stripped) if its path exists
 * on disk, so ordinary markdown links to non-existent paths survive intact.
 */
export function extractMediaRefs(text, exists) {
	const media = [];
	let t = String(text);
	// Image: ![alt](path)
	t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, path) => {
		const p = path.trim();
		if (/^https?:\/\//i.test(p)) return m;
		if (exists && !exists(p)) return m;
		media.push({ kind: "image", path: p, name: alt.trim() || p.split(/[\\/]/).pop() });
		return "";
	});
	// File: [name](path) where path is a local path (has a separator, not a URL).
	t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, name, path) => {
		const p = path.trim();
		if (/^https?:\/\//i.test(p) || !/[\\/]/.test(p)) return m;
		if (exists && !exists(p)) return m;
		media.push({ kind: "file", path: p, name: name.trim() || p.split(/[\\/]/).pop() });
		return "";
	});
	return { text: t.replace(/\s{2,}/g, " ").trim(), media };
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
/** Validate a workspace entry (name/path) for add/edit. Pure, injectable `exists`. */
export function validateWorkspace({ name, path, list = [], editingIndex = -1, exists = existsSync }) {
	const trimmedName = String(name ?? "").trim();
	const trimmedPath = String(path ?? "").trim();
	if (!trimmedName) return { ok: false, error: "工作区名字不能为空" };
	if (!trimmedPath) return { ok: false, error: "工作区路径不能为空" };
	const dup = list.findIndex((w, i) => i !== editingIndex && w && w.name === trimmedName);
	if (dup !== -1) return { ok: false, error: `工作区名字「${trimmedName}」已存在` };
	if (!exists(trimmedPath)) return { ok: false, error: `路径不存在：${trimmedPath}` };
	return { ok: true, value: { name: trimmedName, path: trimmedPath } };
}
