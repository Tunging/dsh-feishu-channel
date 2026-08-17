import assert from "node:assert/strict";
import { assistantText, chunkText, computeSignature, looksLikeMarkdown, makeRateLimiter, stripMarkdown, timingSafeEqual } from "../lib/utils.js";

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

check("makeRateLimiter enforces window", () => {
	const allow = makeRateLimiter(2, 60 * 1000);
	assert.equal(allow("k"), true);
	assert.equal(allow("k"), true);
	assert.equal(allow("k"), false); // over limit
	assert.equal(allow("other"), true); // different key unaffected
});

console.log(`\n${passed} checks passed`);
