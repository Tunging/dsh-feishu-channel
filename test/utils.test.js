import assert from "node:assert/strict";
import { assistantText, chunkText, computeSignature, extractMediaRefs, looksLikeMarkdown, makeRateLimiter, sanitizeFilename, stripMarkdown, timingSafeEqual } from "../lib/utils.js";

let passed = 0;
function check(label, fn) {
	fn();
	passed += 1;
	console.log(`  ok - ${label}`);
}

console.log("utils tests");
check("assistantText joins text blocks, ignores tool calls", () => {
	const msg = { content: [
		{ type: "text", text: "Hello " },
		{ type: "tool-call", id: "1" },
		{ type: "text", text: "world" }
	] };
	assert.equal(assistantText(msg), "Hello world");
	assert.equal(assistantText({ content: [] }), "");
});

check("chunkText splits and handles empty", () => {
	assert.deepEqual(chunkText("123456", 3), ["123", "456"]);
	assert.deepEqual(chunkText("", 10), [""]);
	assert.deepEqual(chunkText("abc", 10), ["abc"]);
});

check("looksLikeMarkdown detects markdown but not plain text", () => {
	assert.equal(looksLikeMarkdown("plain text here"), false);
	assert.equal(looksLikeMarkdown("## Heading"), true);
	assert.equal(looksLikeMarkdown("**bold**"), true);
	assert.equal(looksLikeMarkdown("```js\nlet x = 1;\n```"), true);
	assert.equal(looksLikeMarkdown("[link](https://a.com)"), true);
	assert.equal(looksLikeMarkdown("- item"), true);
});

check("stripMarkdown produces plain text", () => {
	assert.equal(stripMarkdown("**bold** and `code`"), "bold and code");
	assert.equal(stripMarkdown("# Title"), "Title");
	assert.equal(stripMarkdown("[x](https://a.com)"), "x");
	assert.equal(stripMarkdown("- a\n- b"), "a\nb");
});

check("computeSignature + timingSafeEqual round-trip", () => {
	const sig = computeSignature("key", "123", "abc", "{}");
	assert.equal(timingSafeEqual(sig, sig), true);
	assert.equal(timingSafeEqual(sig, "nope"), false);
});

check("sanitizeFilename strips path separators and control chars", () => {
	assert.equal(sanitizeFilename("a/b\\c:d*e?f\"g<h>i|j"), "a_b_c_d_e_f_g_h_i_j");
	assert.equal(sanitizeFilename("  report.pdf  "), "report.pdf");
	assert.equal(sanitizeFilename(""), "file");
});

check("extractMediaRefs pulls local image/file refs and strips them", () => {
	const { text, media } = extractMediaRefs("看图 ![diagram](C:\\tmp\\a.png) 和文件 [report.pdf](C:\\tmp\\report.pdf) 以及链接 [site](https://a.com)");
	assert.equal(text, "看图 和文件 以及链接 [site](https://a.com)");
	assert.equal(media.length, 2);
	assert.equal(media[0].kind, "image");
	assert.equal(media[0].path, "C:\\tmp\\a.png");
	assert.equal(media[1].kind, "file");
	assert.equal(media[1].path, "C:\\tmp\\report.pdf");
});

check("extractMediaRefs keeps refs whose path does not exist when exists is given", () => {
	const { text, media } = extractMediaRefs("![x](C:\\missing.png)", (p) => p === "C:\\exists.png");
	assert.equal(text, "![x](C:\\missing.png)");
	assert.equal(media.length, 0);
	const { text: t2, media: m2 } = extractMediaRefs("![x](C:\\exists.png)", (p) => p === "C:\\exists.png");
	assert.equal(t2, "");
	assert.equal(m2.length, 1);
});

check("makeRateLimiter enforces window", () => {
	const allow = makeRateLimiter(2, 60 * 1000);
	assert.equal(allow("k"), true);
	assert.equal(allow("k"), true);
	assert.equal(allow("k"), false); // over limit
	assert.equal(allow("other"), true); // different key unaffected
});

console.log(`\n${passed} checks passed`);
