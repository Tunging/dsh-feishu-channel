import { Command } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";
import { existsSync, readFileSync } from "node:fs";
import { credentialsPath, loadCredentials, runOnboarding, saveCredentials } from "./onboard.js";
//#region lib/types/startup.js
/**
 * The Feishu surface's command-line provider: it parses the Feishu app
 * credentials, transport mode, gating/security options, then publishes
 * {@link FEISHU_STARTUP_SERVICE}. The runner is an ordinary consumer whose
 * lazy config waits for that service.
 *
 * Two entry points:
 *  - `dsh --profile feishu setup` — scan-to-create onboarding: prints a QR
 *    link, polls until the user scans it in the Feishu app, then saves the
 *    created app credentials to `$DSH_HOME/feishu-credentials.json`. It also
 *    publishes a `mode: "setup"` config so the runner activates without
 *    starting (it sees empty credentials and stands down).
 *  - `dsh --profile feishu ...` — run the bot. Credentials come from CLI
 *    flags, or fall back to the saved credentials file.
 * @module @you/dsh-feishu/startup
 */
/** Stable Cordis plugin name. */
const name = "feishu-startup";
/** Services required before the config can be resolved. */
const inject = ["cmdlineArgs"];
/** Service provided by this plugin and injected by the runner. */
const FEISHU_STARTUP_SERVICE = "feishuStartup";
/** Best-effort ASCII QR render; returns false when `qrcode` is unavailable. */
async function renderQr(url) {
	try {
		const { default: QRCode } = await import("qrcode");
		QRCode.toString(url, { type: "terminal", small: true }, (err, s) => {
			if (err) return;
			process.stdout.write("\n" + s + "\n");
		});
		return true;
	} catch {
		return false;
	}
}
/** Load the workspace list from a JSON file, or return []. */
function loadWorkspaces(file) {
	if (!file || !existsSync(file)) return [];
	try {
		const list = JSON.parse(readFileSync(file, "utf8"));
		if (!Array.isArray(list)) return [];
		return list.filter((w) => w && typeof w.name === "string" && typeof w.path === "string");
	} catch {
		return [];
	}
}
/** Load the bot list from a JSON file, or return []. */
function loadBots(file) {
	if (!file || !existsSync(file)) return [];
	try {
		const list = JSON.parse(readFileSync(file, "utf8"));
		if (!Array.isArray(list)) return [];
		return list.filter((b) => b && typeof b.name === "string" && typeof b.appId === "string" && typeof b.appSecret === "string");
	} catch {
		return [];
	}
}
/** Build the runner config from CLI opts + resolved credentials. */
function buildConfig(opts, creds) {
	const port = Number.parseInt(opts.port, 10);
	return {
		appId: creds.appId,
		appSecret: creds.appSecret,
		mode: opts.mode === "longconn" ? "longconn" : "webhook",
		port: Number.isNaN(port) ? 8080 : port,
		host: opts.host ?? "0.0.0.0",
		path: opts.path ?? "/",
		domain: opts.domain === "lark" ? "lark" : "feishu",
		workspaceRoot: opts.workspace ?? process.cwd(),
		workspaces: loadWorkspaces(opts.workspacesFile),
		bots: loadBots(opts.botsFile),
		stateFile: opts.stateFile ?? "",
		configPort: Number.parseInt(opts.configPort, 10) || 8081,
		botsFile: opts.botsFile ?? "",
		workspacesFile: opts.workspacesFile ?? "",
		botOpenId: opts.botOpenId,
		botUserId: opts.botUserId,
		botName: opts.botName,
		allowedUsers: opts.allowedUsers ?? "",
		allowAllUsers: Boolean(opts.allowAllUsers),
		groupPolicy: opts.groupPolicy ?? "allowlist",
		requireMention: opts.requireMention !== "false" && opts.requireMention !== "0",
		allowBots: opts.allowBots ?? "none",
		verificationToken: opts.verificationToken,
		encryptKey: opts.encryptKey,
		enableCards: opts.cards !== false,
		enableReactions: opts.reactions !== false,
		textBatchDelayMs: Number.parseInt(opts.textBatchMs, 10) || 600
	};
}
/**
 * This app's command: the Feishu credentials, transport mode, and options.
 * @param ctx - plugin context, so the `setup` subcommand can publish the
 *   runner config synchronously (the runner must activate even in setup mode).
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function feishuCommand(ctx) {
	const program = new Command().name("dsh --profile feishu").description("Run a Feishu bot surface that drives a DeepSeek Harness agent.").helpOption("-h, --help", "show this help").option("--app-id <id>", "Feishu app id (or run `setup` to create one by scanning)").option("--app-secret <secret>", "Feishu app secret").option("--mode <mode>", "transport: 'webhook' (event subscription) or 'longconn' (WebSocket)", "webhook").option("--port <port>", "listen port for webhook mode", "8080").option("--host <host>", "webhook bind address", "0.0.0.0").option("--path <path>", "webhook endpoint path", "/").option("--domain <domain>", "'feishu' (China) or 'lark' (International)", "feishu").option("--workspace <dir>", "workspace root for fresh sessions", process.cwd()).option("--state-file <file>", "JSON file persisting chat_id -> sessionId").option("--workspaces-file <path>", "JSON file with [{name,path}] workspace list for the /workspace picker").option("--bots-file <path>", "JSON file with [{name,appId,appSecret,domain}] bot list for the /bot picker").option("--config-port <port>", "local config page port (default 8081)", "8081").option("--bot-open-id <id>", "bot open_id (for @mention gating)").option("--bot-user-id <id>", "bot user_id (for @mention gating)").option("--bot-name <name>", "bot display name (for @mention gating)").option("--allowed-users <ids>", "comma-separated open_id allowlist").option("--allow-all-users", "allow any Feishu user (dev only)").option("--group-policy <policy>", "group policy: open | allowlist | disabled", "allowlist").option("--require-mention <bool>", "groups must @mention the bot (true/false)", "true").option("--allow-bots <mode>", "accept peer bot messages: none | mentions | all", "none").option("--verification-token <token>", "webhook verification token").option("--encrypt-key <key>", "webhook signature encrypt key").option("--no-cards", "disable interactive approval/question cards").option("--no-reactions", "disable processing reactions").option("--text-batch-ms <ms>", "burst text debounce delay (ms)", "600").addHelpText("after", `
Examples:
  dsh --profile feishu setup                       # scan-to-create a bot app
  dsh --profile feishu --mode longconn             # run (uses saved credentials)
  dsh --profile feishu --app-id cli_xxx --app-secret yyy --mode webhook --port 8080
`);
	// Scan-to-create onboarding subcommand.
	program.command("setup").description("Create a Feishu bot app by scanning a QR code (no developer console needed)").option("--domain <domain>", "'feishu' (China) or 'lark' (International)", "feishu").option("--timeout <seconds>", "how long to wait for the scan", "600").option("--qr", "render an ASCII QR in the terminal (requires the 'qrcode' package)").action(async (opts) => {
		// Publish a setup-mode config synchronously so the runner activates
		// (it sees empty credentials and stands down) instead of blocking boot.
		ctx.provide(FEISHU_STARTUP_SERVICE, buildConfig(opts, { appId: "", appSecret: "" }));
		const domain = opts.domain === "lark" ? "lark" : "feishu";
		const timeout = Number.parseInt(opts.timeout, 10) || 600;
		process.stdout.write("Connecting to Feishu / Lark…\n");
		try {
			const result = await runOnboarding({
				domain,
				timeoutSeconds: timeout,
				onQrUrl: (url) => {
					process.stdout.write("\n📱 用飞书/飞书国际版 App 扫码，或直接打开这个链接完成接入：\n");
					process.stdout.write(`   ${url}\n\n`);
					if (opts.qr) renderQr(url);
				},
				onStatus: (s) => process.stdout.write(`  ${s}\n`)
			});
			if (!result) {
				process.stderr.write("Registration failed (denied, expired, or timed out).\n");
				process.exit(1);
			}
			saveCredentials(result);
			const credFile = credentialsPath();
			process.stdout.write(`\n✅ Bot app created and saved to:\n   ${credFile}\n`);
			process.stdout.write(`   app_id: ${result.appId}\n`);
			process.stdout.write(`   domain: ${result.domain}\n`);
			if (result.botName) process.stdout.write(`   bot:    ${result.botName}\n`);
			process.stdout.write("\nNow run the bot:\n");
			process.stdout.write(`   dsh --profile feishu --mode longconn\n`);
			process.exit(0);
		} catch (e) {
			process.stderr.write(`Onboarding failed: ${e instanceof Error ? e.message : String(e)}\n`);
			process.exit(1);
		}
	});
	return program;
}
/**
 * Parse and provide the Feishu config as an ordinary Cordis service.
 * @param ctx - plugin context carrying the command line.
 */
function apply(ctx) {
	const program = feishuCommand(ctx);
	program.action(() => {
		const opts = program.opts();
		// Credentials: CLI flags win; otherwise fall back to the saved file.
		let appId = opts.appId;
		let appSecret = opts.appSecret;
		if (!appId || !appSecret) {
			const saved = loadCredentials();
			if (saved && saved.appId && saved.appSecret) {
				appId = appId || saved.appId;
				appSecret = appSecret || saved.appSecret;
			}
		}
		if (!appId || !appSecret) {
			program.error("error: missing --app-id/--app-secret. Run `dsh --profile feishu setup` to create a bot by scanning, or pass the credentials explicitly.");
		}
		const port = Number.parseInt(opts.port, 10);
		if (Number.isNaN(port) || port <= 0 || port > 65535) program.error(`error: invalid --port: ${opts.port}`);
		ctx.provide(FEISHU_STARTUP_SERVICE, buildConfig(opts, { appId, appSecret }));
	});
	parseCmdline(ctx, program);
}
//#endregion
export { FEISHU_STARTUP_SERVICE, apply, inject, name };
