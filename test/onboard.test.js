import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCredentials, saveCredentials } from "../lib/onboard.js";

let passed = 0;
function check(label, fn) {
	fn();
	passed += 1;
	console.log(`  ok - ${label}`);
}

console.log("onboard tests");
check("credentials save/load round-trip", () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-feishu-"));
	const file = join(dir, "creds.json");
	try {
		const creds = { appId: "cli_x", appSecret: "s", domain: "feishu", botName: "Bot" };
		saveCredentials(creds, file);
		assert.deepEqual(loadCredentials(file), creds);
		assert.equal(loadCredentials(join(dir, "missing.json")), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

console.log(`\n${passed} checks passed`);
