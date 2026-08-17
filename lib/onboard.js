/**
 * Feishu / Lark scan-to-create onboarding: the device-code registration flow
 * that lets a user scan a QR (or open a link) in the Feishu app to create a
 * bot application with the right credentials, without touching the developer
 * console. Mirrors hermes-agent's `qr_register` flow against
 * `accounts.feishu.cn/oauth/v1/app/registration`.
 *
 * Pure node:https — no lark SDK dependency, so it works before deps install.
 * @module @you/dsh-feishu/onboard
 */
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const ACCOUNTS_HOSTS = { feishu: "accounts.feishu.cn", lark: "accounts.larksuite.com" };
const OPEN_HOSTS = { feishu: "open.feishu.cn", lark: "open.larksuite.com" };
const REGISTRATION_PATH = "/oauth/v1/app/registration";
const REQUEST_TIMEOUT_MS = 10000;

function accountsHost(domain) {
	return ACCOUNTS_HOSTS[domain] ?? ACCOUNTS_HOSTS.feishu;
}
function openHost(domain) {
	return OPEN_HOSTS[domain] ?? OPEN_HOSTS.feishu;
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Promise wrapper around node:https JSON requests to the Feishu open API. */
export function httpsJson(domain, path, method, body, token) {
	const host = openHost(domain);
	const headers = { "Content-Type": "application/json" };
	if (token !== void 0) headers.Authorization = `Bearer ${token}`;
	return new Promise((resolve, reject) => {
		const req = httpsRequest({ host, path, method, headers, timeout: REQUEST_TIMEOUT_MS }, (res) => {
			let data = "";
			res.on("data", (c) => (data += c));
			res.on("end", () => {
				try {
					resolve(JSON.parse(data));
				} catch (e) {
					reject(e);
				}
			});
		});
		req.on("error", reject);
		req.on("timeout", () => req.destroy(new Error("https timeout")));
		if (body !== void 0) req.write(body);
		req.end();
	});
}
/** Form-encoded POST to the registration endpoint; parses JSON even on 4xx. */
function formPost(domain, body) {
	const data = new URLSearchParams(body).toString();
	return new Promise((resolve, reject) => {
		const req = httpsRequest({
			host: accountsHost(domain),
			path: REGISTRATION_PATH,
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"Content-Length": Buffer.byteLength(data)
			},
			timeout: REQUEST_TIMEOUT_MS
		}, (res) => {
			let raw = "";
			res.on("data", (c) => (raw += c));
			res.on("end", () => {
				try {
					resolve({ status: res.statusCode, json: JSON.parse(raw) });
				} catch (e) {
					reject(e);
				}
			});
		});
		req.on("error", reject);
		req.on("timeout", () => req.destroy(new Error("registration timeout")));
		req.write(data);
		req.end();
	});
}
/** Fetch a tenant_access_token from raw credentials. */
export async function fetchTenantAccessToken(domain, appId, appSecret) {
	const res = await httpsJson(domain, "/open-apis/auth/v3/tenant_access_token/internal", "POST", JSON.stringify({ app_id: appId, app_secret: appSecret }));
	if (res.code !== 0 || !res.tenant_access_token) throw new Error(`tenant token failed: ${res.code} ${res.msg ?? ""}`);
	return res.tenant_access_token;
}
/** Fetch the bot's own open_id + display name via /bot/v3/info. */
export async function fetchBotIdentity(domain, appId, appSecret) {
	const token = await fetchTenantAccessToken(domain, appId, appSecret);
	const res = await httpsJson(domain, "/open-apis/bot/v3/info", "GET", void 0, token);
	if (res.code !== 0 || !res.bot) throw new Error(`bot info failed: ${res.code} ${res.msg ?? ""}`);
	return { openId: res.bot.open_id, userId: res.bot.open_id, name: res.bot.app_name ?? "" };
}
/** Best-effort bot probe; returns null on any failure. */
export async function probeBot(appId, appSecret, domain) {
	try {
		const id = await fetchBotIdentity(domain, appId, appSecret);
		return { botName: id.name, botOpenId: id.openId };
	} catch {
		return null;
	}
}
/** Verify the registration environment supports client_secret auth. */
export async function initRegistration(domain) {
	const res = await formPost(domain, { action: "init" });
	const methods = res.json.supported_auth_methods ?? [];
	if (!methods.includes("client_secret")) {
		throw new Error(`registration env does not support client_secret auth (supported: ${methods.join(", ")})`);
	}
}
/** Start the device-code flow; returns the QR URL + polling parameters. */
export async function beginRegistration(domain) {
	const res = await formPost(domain, {
		action: "begin",
		archetype: "PersonalAgent",
		auth_method: "client_secret",
		request_user_info: "open_id"
	});
	const j = res.json;
	const deviceCode = j.device_code;
	if (!deviceCode) throw new Error("registration did not return a device_code");
	let qrUrl = j.verification_uri_complete ?? "";
	qrUrl += (qrUrl.includes("?") ? "&" : "?") + "from=hermes&tp=hermes";
	return {
		deviceCode,
		qrUrl,
		userCode: j.user_code ?? "",
		interval: j.interval ?? 5,
		expireIn: j.expire_in ?? 600
	};
}
/** Extract credentials from a poll response, tolerating several shapes. */
function extractCredentials(j) {
	const d = j?.data ?? j;
	const clientId = j.client_id ?? d.client_id ?? j.app_id ?? d.app_id;
	const clientSecret = j.client_secret ?? d.client_secret ?? j.app_secret ?? d.app_secret;
	if (clientId && clientSecret) return { appId: clientId, appSecret: clientSecret };
	return null;
}
/** One poll iteration for the config page; returns a status object. */
export async function pollOnce(domain, deviceCode) {
	let res;
	try {
		res = await formPost(domain, { action: "poll", device_code: deviceCode, tp: "ob_app" });
	} catch (e) {
		return { status: "error", error: e instanceof Error ? e.message : String(e) };
	}
	const j = res.json;
	const userInfo = j.user_info ?? j.data?.user_info ?? {};
	const creds = extractCredentials(j);
	if (creds) return { status: "success", appId: creds.appId, appSecret: creds.appSecret, domain, openId: userInfo.open_id };
	const err = j.error ?? "";
	if (err === "access_denied" || err === "expired_token") return { status: "error", error: err };
	return { status: "pending" };
}
/** Poll until the user scans the QR, or timeout/denial. Returns credentials or null. */
export async function pollRegistration(domain, deviceCode, interval, expireIn, onStatus) {
	const deadline = Date.now() + expireIn * 1000;
	let currentDomain = domain;
	let switched = false;
	while (Date.now() < deadline) {
		let res;
		try {
			res = await formPost(currentDomain, { action: "poll", device_code: deviceCode, tp: "ob_app" });
		} catch (e) {
			onStatus?.(`poll error: ${e instanceof Error ? e.message : e}`);
			await sleep(interval * 1000);
			continue;
		}
		const j = res.json;
		const userInfo = j.user_info ?? j.data?.user_info ?? {};
		if (userInfo.tenant_brand === "lark" && !switched) {
			currentDomain = "lark";
			switched = true;
		}
		const creds = extractCredentials(j);
		if (creds) {
			return { appId: creds.appId, appSecret: creds.appSecret, domain: currentDomain, openId: userInfo.open_id };
		}
		const err = j.error ?? j.msg ?? "";
		if (err === "access_denied" || err === "expired_token") {
			onStatus?.(`registration ${err}`);
			return null;
		}
		// Diagnostic: surface the server's code/error so a stuck poll is debuggable.
		const code = j.code ?? "";
		onStatus?.(`waiting for scan… (code=${code}${err ? `, error=${err}` : ""})`);
		await sleep(interval * 1000);
	}
	onStatus?.("timed out");
	return null;
}
/** Run the full onboarding flow; returns credentials + bot info, or null. */
export async function runOnboarding({ domain = "feishu", timeoutSeconds = 600, onStatus, onQrUrl } = {}) {
	await initRegistration(domain);
	const begin = await beginRegistration(domain);
	onQrUrl?.(begin.qrUrl);
	onStatus?.("ready");
	const result = await pollRegistration(domain, begin.deviceCode, begin.interval, Math.min(begin.expireIn, timeoutSeconds), onStatus);
	if (!result) return null;
	const bot = await probeBot(result.appId, result.appSecret, result.domain);
	return {
		appId: result.appId,
		appSecret: result.appSecret,
		domain: result.domain,
		openId: result.openId,
		botName: bot?.botName ?? null,
		botOpenId: bot?.botOpenId ?? null
	};
}
/** Default path for the saved credentials file. */
export function credentialsPath() {
	const home = process.env.DSH_HOME || join(homedir(), ".dsh");
	return join(home, "feishu-credentials.json");
}
/** Load saved credentials, or null. */
export function loadCredentials(file = credentialsPath()) {
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}
/** Persist credentials to the file. */
export function saveCredentials(creds, file = credentialsPath()) {
	mkdirSync(dirnameOf(file), { recursive: true });
	writeFileSync(file, JSON.stringify(creds, null, 2), "utf8");
}
function dirnameOf(p) {
	const i = p.lastIndexOf("/");
	const j = p.lastIndexOf("\\");
	const k = Math.max(i, j);
	return k === -1 ? "." : p.slice(0, k);
}
