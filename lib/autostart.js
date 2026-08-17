import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
//#region lib/types/autostart.js
/**
 * @tunging/dsh-feishu/autostart — a tiny launcher plugin that spawns the Feishu
 * bot as a detached child process when the host profile boots. Add this plugin
 * to any profile (e.g. the web profile) so the Feishu channel starts
 * automatically alongside DSH, without mounting the full Feishu surface.
 *
 * It runs `dsh --profile <profile> --mode <mode> [--bots-file <file>]` as a
 * detached subprocess and detaches it from the parent's lifetime.
 * @module @tunging/dsh-feishu/autostart
 */
/** Stable Cordis plugin name. */
const name = "feishu-autostart";
/** No services required. */
const inject = [];
const Config = z.object({
	profile: z.string().default("feishu"),
	mode: z.string().default("longconn"),
	botsFile: z.string().default(""),
	logFile: z.string().default(""),
	extraArgs: z.array(z.string()).default([])
});
/**
 * Spawn the Feishu bot as a detached child process.
 * @param ctx - plugin context (for logging).
 * @param config - validated autostart config.
 */
function apply(ctx, config) {
	const args = ["--profile", config.profile, "--mode", config.mode];
	if (config.botsFile) args.push("--bots-file", config.botsFile);
	args.push(...config.extraArgs);
	const logPath = config.logFile || join(process.env.DSH_HOME || homedir(), "dsh-feishu.log");
	let out;
	try {
		out = openSync(logPath, "a");
	} catch {
		out = "ignore";
	}
	const child = spawn("dsh", args, { shell: true, detached: true, stdio: ["ignore", out, out] });
	child.unref();
	ctx.logger.info(`[feishu-autostart] spawned: dsh ${args.join(" ")} (pid ${child.pid})`);
}
//#endregion
export { Config, apply, inject, name };
