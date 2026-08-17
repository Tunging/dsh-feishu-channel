import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { assistantText, chunkText, computeSignature, looksLikeMarkdown, makeRateLimiter, stripMarkdown, timingSafeEqual } from "./utils.js";
import { beginRegistration, fetchBotIdentity, pollOnce } from "./onboard.js";
import * as lark from "@larksuiteoapi/node-sdk";
//#region lib/types/index.js
/**
 * @you/dsh-feishu — a Feishu (Lark) bot surface for DeepSeek Harness.
 * The bundle patch rides over dsh-base without a browser layer; this runner
 * creates one Agent per Feishu chat through the core registry, forwards user
 * messages via `agent.followup`, and streams assistant replies back to Feishu.
 *
 * Feature surface (see docs/feishu-channel-research.md):
 *  - Transport: webhook (event subscription) or longconn (Feishu WebSocket).
 *  - Group @mention gating + per-user allowlist + group policy.
 *  - markdown -> Feishu `post` (md) rendering with plain-text fallback.
 *  - Webhook security: verification token, signature (encrypt key), rate limit.
 *  - Message-id dedup with TTL.
 *  - Approval and ask-user questions rendered as interactive Feishu cards.
 *  - Session persistence: chat_id -> resumeSessionId survives restarts.
 *  - Burst batching, bot self-message filtering, optional processing reaction.
 *
 * @module @you/dsh-feishu
 */
/** Stable Cordis plugin name. */
const name = "feishu-runner";
/** Core services required before a turn can start. */
const inject = ["agentDefaultModel", "agents", "sessions"];
const Config = z.object({
	appId: z.string().required(),
	appSecret: z.string().required(),
	mode: z.string().default("webhook"),
	port: z.number().default(8080),
	host: z.string().default("0.0.0.0"),
	path: z.string().default("/"),
	domain: z.string().default("feishu"),
	workspaceRoot: z.string().default(process.cwd()),
	workspaces: z.array(z.object({ name: z.string(), path: z.string() })).default([]),
	bots: z.array(z.object({ name: z.string(), appId: z.string(), appSecret: z.string(), domain: z.string().default("feishu") })).default([]),
	botOpenId: z.string(),
	botUserId: z.string(),
	botName: z.string(),
	allowedUsers: z.string().default(""),
	allowAllUsers: z.boolean().default(false),
	groupPolicy: z.string().default("allowlist"),
	requireMention: z.boolean().default(true),
	allowBots: z.string().default("none"),
	admins: z.string().default(""),
	groupRules: z.array(z.object({
		chatId: z.string(),
		policy: z.string().default("open"),
		allowlist: z.array(z.string()).default([]),
		blacklist: z.array(z.string()).default([])
	})).default([]),
	allowedTools: z.array(z.string()).default([]),
	dangerousCommands: z.array(z.string()).default([]),
	verificationToken: z.string(),
	encryptKey: z.string(),
	enableCards: z.boolean().default(true),
	enableReactions: z.boolean().default(true),
	maxTextChunk: z.number().default(30000),
	maxMdChunk: z.number().default(20000),
	textBatchDelayMs: z.number().default(600),
	textBatchMaxMessages: z.number().default(8),
	textBatchMaxChars: z.number().default(4000),
	dedupTtlMs: z.number().default(24 * 60 * 60 * 1000),
	maxWebhookBodyBytes: z.number().default(1024 * 1024),
	rateLimitMax: z.number().default(120),
	stateFile: z.string().default(""),
	configPort: z.number().default(8081),
	botsFile: z.string().default(""),
	workspacesFile: z.string().default("")
});
/** The process streams the runner writes to; tests substitute captures. */
const internals = {
	stdout: process.stdout,
	stderr: process.stderr
};
/** Self-contained config page served at http://127.0.0.1:<configPort>/. */
const CONFIG_PAGE_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>飞书频道配置</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f6f8;color:#1f2329;margin:0;padding:24px}
  .wrap{max-width:760px;margin:0 auto}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:#646a73;font-size:13px;margin:0 0 20px}
  .card{background:#fff;border:1px solid #e5e6eb;border-radius:12px;padding:16px 18px;margin-bottom:20px}
  .card h2{font-size:15px;margin:0 0 12px}
  .row{display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap}
  .row input{flex:1;min-width:120px;padding:7px 10px;border:1px solid #d0d3d9;border-radius:8px;font-size:13px}
  .row input.wide{flex:2}
  .btn{padding:7px 14px;border:none;border-radius:8px;font-size:13px;cursor:pointer}
  .btn.primary{background:#3370ff;color:#fff}
  .btn.danger{background:#fff;color:#d54941;border:1px solid #d0d3d9}
  .btn.add{background:#f2f3f5;color:#1f2329;border:1px solid #d0d3d9}
  .savebar{position:sticky;bottom:0;background:#f5f6f8;padding:12px 0}
  .toast{position:fixed;top:16px;right:16px;background:#3370ff;color:#fff;padding:10px 16px;border-radius:8px;opacity:0;transition:opacity .2s;font-size:13px}
  .toast.show{opacity:1}
  .hint{color:#8f959e;font-size:12px;margin:4px 0 0}
</style>
</head>
<body>
<div class="wrap">
  <h1>飞书频道配置</h1>
  <p class="sub">编辑后点「保存」，重启 bot 生效。机器人切换可在飞书里发 /bot。</p>

  <div class="card">
    <h2>机器人列表</h2>
    <div id="bots"></div>
    <div class="row" style="margin-top:8px">
      <button class="btn add" onclick="addBot()">+ 手动填写</button>
      <button class="btn primary" onclick="scanBot()">📷 扫码添加</button>
    </div>
    <div id="scanbox" style="display:none;margin-top:12px;padding:12px;border:1px dashed #d0d3d9;border-radius:8px">
      <div id="scanqr"></div>
      <p class="hint" id="scanstatus">用飞书 App 扫码或打开链接…</p>
    </div>
  </div>

  <div class="card">
    <h2>工作区列表</h2>
    <div id="workspaces"></div>
    <button class="btn add" onclick="addWs()">+ 添加工作区</button>
  </div>

  <div class="savebar">
    <button class="btn primary" onclick="save()">保存配置</button>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
let state = { bots: [], workspaces: [] };
async function load(){
  const r = await fetch('/api/config');
  state = await r.json();
  render();
}
function render(){
  const b = document.getElementById('bots');
  b.innerHTML = '';
  state.bots.forEach((bot,i)=>{
    const row = document.createElement('div'); row.className='row';
    row.innerHTML = '<input class="wide" placeholder="名称" value="'+esc(bot.name)+'">'
      +'<input placeholder="App ID" value="'+esc(bot.appId)+'">'
      +'<input placeholder="App Secret" value="'+esc(bot.appSecret)+'">'
      +'<input style="max-width:90px" placeholder="domain" value="'+esc(bot.domain||'feishu')+'">'
      +'<button class="btn danger" onclick="removeBot('+i+')">删</button>';
    row.querySelectorAll('input').forEach((inp,idx)=>{
      inp.oninput = ()=>{ const f=['name','appId','appSecret','domain']; state.bots[i][f[idx]]=inp.value; };
    });
    b.appendChild(row);
  });
  const w = document.getElementById('workspaces');
  w.innerHTML = '';
  state.workspaces.forEach((ws,i)=>{
    const row = document.createElement('div'); row.className='row';
    row.innerHTML = '<input class="wide" placeholder="名称" value="'+esc(ws.name)+'">'
      +'<input placeholder="路径" value="'+esc(ws.path)+'">'
      +'<button class="btn danger" onclick="removeWs('+i+')">删</button>';
    row.querySelectorAll('input').forEach((inp,idx)=>{
      inp.oninput = ()=>{ const f=['name','path']; state.workspaces[i][f[idx]]=inp.value; };
    });
    w.appendChild(row);
  });
}
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function addBot(){ state.bots.push({name:'',appId:'',appSecret:'',domain:'feishu'}); render(); }
function removeBot(i){ state.bots.splice(i,1); render(); }
function addWs(){ state.workspaces.push({name:'',path:''}); render(); }
function removeWs(i){ state.workspaces.splice(i,1); render(); }
async function save(){
  const r = await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(state)});
  const j = await r.json();
  toast(j.ok ? '已保存' : '保存失败：'+(j.error||''));
}
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2000); }
let scanTimer = null;
async function scanBot(){
  const box = document.getElementById('scanbox');
  box.style.display = 'block';
  document.getElementById('scanstatus').textContent = '正在连接飞书…';
  const r = await fetch('/api/onboard/begin',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  const j = await r.json();
  if(!j.qrUrl){ toast('扫码失败：'+(j.error||'')); return; }
  document.getElementById('scanqr').innerHTML =
    '<img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data='+encodeURIComponent(j.qrUrl)+'" alt="QR">'
    +'<p class="hint"><a href="'+j.qrUrl+'" target="_blank">打不开？点这里在飞书里打开</a></p>';
  document.getElementById('scanstatus').textContent = '用飞书 App 扫码，或打开链接完成授权…';
  clearInterval(scanTimer);
  scanTimer = setInterval(pollScan, (j.interval||5)*1000);
}
async function pollScan(){
  const r = await fetch('/api/onboard/poll',{method:'POST'});
  const j = await r.json();
  if(j.status==='success'){
    clearInterval(scanTimer);
    document.getElementById('scanstatus').textContent = '✅ 创建成功，已加入列表';
    state.bots.push({name:'新机器人',appId:j.appId,appSecret:j.appSecret,domain:j.domain||'feishu'});
    render();
    setTimeout(()=>{ document.getElementById('scanbox').style.display='none'; }, 2000);
  } else if(j.status==='error'){
    clearInterval(scanTimer);
    document.getElementById('scanstatus').textContent = '❌ 失败：'+(j.error||'');
  } else {
    document.getElementById('scanstatus').textContent = '等待扫码…';
  }
}
load();
</script>
</body>
</html>`;
/**
 * A per-chat agent holder: owns the DSH AgentHandle and the Feishu reply target.
 */
class ChatAgent {
	constructor(handle, chatId, clientRef, config) {
		this.handle = handle;
		this.agent = handle.agent;
		this.chatId = chatId;
		this.clientRef = clientRef;
		this.config = config;
		this.busy = false;
	}
	/** Send one raw Feishu message payload (msg_type + content). */
	async send(msgType, content) {
		return await this.clientRef.current.im.message.create({
			params: { receive_id_type: "chat_id" },
			data: { receive_id: this.chatId, msg_type: msgType, content: JSON.stringify(content) }
		});
	}
	/** Choose post(md) when the text looks like markdown, else plain text. */
	async reply(text) {
		const isMd = looksLikeMarkdown(text);
		const max = isMd ? this.config.maxMdChunk : this.config.maxTextChunk;
		for (const part of chunkText(text, max)) {
			if (isMd) {
				try {
					await this.send("post", { zh_cn: { title: "", content: [[{ tag: "md", text: part }]] } });
				} catch {
					await this.send("text", { text: stripMarkdown(part) });
				}
			} else {
				await this.send("text", { text: part });
			}
		}
	}
	/** Show a processing reaction while the agent works (best effort). */
	async addReaction(messageId) {
		if (!this.config.enableReactions || !messageId) return null;
		try {
			const res = await this.clientRef.current.im.messageReaction.create({
				path: { message_id: messageId },
				data: { reaction_type: { emoji_type: "THUMBSUP" } }
			});
			return res?.data?.reaction_id ?? res?.reaction_id ?? null;
		} catch {
			return null;
		}
	}
	/** Clear a processing reaction (best effort). */
	async clearReaction(messageId, reactionId) {
		if (!messageId || !reactionId) return;
		try {
			await this.clientRef.current.im.messageReaction.delete({ path: { message_id: messageId, reaction_id: reactionId } });
		} catch {
			/* ignore */
		}
	}
	log(tag, err) {
		internals.stderr.write(`[feishu] ${tag}: ${err instanceof Error ? err.message : String(err)}\n`);
	}
}
//#region webhook helpers
/**
 * Mount the Feishu surface: build the client, wire the transport, enforce
 * gating, and drive agents on incoming messages.
 * @param ctx - plugin context carrying core services.
 * @param config - validated Feishu config.
 */
function apply(ctx, config) {
	// Setup mode (or missing credentials): stand down without starting the bot.
	if (!config.appId || !config.appSecret) {
		internals.stderr.write("[feishu] no credentials — setup mode, not starting bot\n");
		return;
	}
	// Mutable client holder so a runtime bot switch can swap the connection.
	const clientRef = { current: new lark.Client({
		appId: config.appId,
		appSecret: config.appSecret,
		appType: lark.AppType.SelfBuild,
		domain: config.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu
	}) };
	/** Mask sensitive values (app_secret, app_id, open/chat ids) in log output. */
	function redact(text) {
		let s = String(text);
		if (config.appSecret) s = s.split(config.appSecret).join("***");
		if (config.appId) s = s.split(config.appId).join("cli_***");
		s = s.replace(/ou_[a-zA-Z0-9]{10,}/g, "ou_***");
		s = s.replace(/oc_[a-zA-Z0-9]{10,}/g, "oc_***");
		s = s.replace(/om_[a-zA-Z0-9]{10,}/g, "om_***");
		return s;
	}
	const log = (msg) => internals.stderr.write(redact(msg));
	/** chat_id -> ChatAgent */
	const chats = new Map();
	/** session.id -> ChatAgent, so the shared session/event subscription can route replies. */
	const bySession = new Map();
	/** message_id -> timestamp, for dedup with TTL. */
	const seenMessages = new Map();
	/** chat_id -> pending text-batch accumulator. */
	const batchState = new Map();
	/** Bot identity state, resolved lazily. */
	let botIdentity = {
		openId: config.botOpenId,
		userId: config.botUserId,
		name: config.botName
	};
	let botResolvePromise = null;
	/** Resolve bot identity from config, else best-effort from the open API. */
	function resolveBotIdentity() {
		if (botIdentity.openId || botIdentity.name) return botIdentity;
		if (botResolvePromise === null) {
			botResolvePromise = fetchBotIdentity(config.domain, config.appId, config.appSecret)
				.then((id) => {
					botIdentity = { ...botIdentity, ...id };
					return botIdentity;
				})
				.catch((e) => {
					log(`[feishu] bot identity resolution failed: ${e instanceof Error ? e.message : e}\n`);
					return botIdentity;
				});
		}
		return botResolvePromise;
	}

	// --- state persistence (chat_id -> resumeSessionId) ---------------------
	const statePath = config.stateFile && config.stateFile.trim() !== ""
		? config.stateFile
		: join(config.workspaceRoot, ".dsh-feishu-state.json");
	let state = { chats: {}, workspaces: {} };
	if (existsSync(statePath)) {
		try {
			state = JSON.parse(readFileSync(statePath, "utf8"));
			state.chats = state.chats ?? {};
			state.workspaces = state.workspaces ?? {};
		} catch {
			state = { chats: {}, workspaces: {} };
		}
	}
	function persistState() {
		try {
			mkdirSync(dirname(statePath), { recursive: true });
			writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
		} catch (e) {
			log(`[feishu] state persist failed: ${e instanceof Error ? e.message : e}\n`);
		}
	}
	/** The working directory for a chat: its selected workspace, else the default root. */
	function chatWorkspace(chatId) {
		return state.workspaces?.[chatId]?.path || config.workspaceRoot;
	}

	// --- dedup --------------------------------------------------------------
	function isDuplicate(messageId) {
		if (!messageId) return false;
		const now = Date.now();
		const at = seenMessages.get(messageId);
		if (at !== void 0) return true;
		for (const [id, t] of seenMessages) if (now - t > config.dedupTtlMs) seenMessages.delete(id);
		seenMessages.set(messageId, now);
		return false;
	}

	// --- gating -------------------------------------------------------------
	function senderOpenId(event) {
		return event?.sender?.sender_id?.open_id ?? event?.sender?.sender_id?.user_id ?? "";
	}
	function senderIsBot(event) {
		return event?.sender?.sender_type === "app";
	}
	function mentionsBot(mentions) {
		if (!Array.isArray(mentions)) return false;
		return mentions.some((m) => {
			const id = m?.id?.open_id ?? m?.id?.user_id;
			if (id && id === botIdentity.openId) return true;
			if (botIdentity.name && m?.name === botIdentity.name) return true;
			if (botIdentity.userId && id === botIdentity.userId) return true;
			return false;
		});
	}
	function isAdmin(openId) {
		if (!openId) return false;
		return config.admins.split(",").map((s) => s.trim()).filter(Boolean).includes(openId);
	}
	function groupRuleFor(chatId) {
		return (config.groupRules ?? []).find((r) => r.chatId === chatId);
	}
	/** Return true when this inbound message is allowed through the gate. */
	function admit(event, message) {
		// Self messages (our own echo) are always dropped.
		if (senderIsBot(event)) {
			if (config.allowBots === "none") return false;
			if (config.allowBots === "mentions") return mentionsBot(message?.mentions);
			return true; // allowBots === "all"
		}
		const chatType = message?.chat_type ?? event?.message?.chat_type ?? "p2p";
		const isGroup = chatType === "group" || chatType === "chat" || chatType === "thread";
		const openId = senderOpenId(event);
		const admin = isAdmin(openId);
		if (isGroup) {
			const rule = groupRuleFor(message.chat_id);
			const policy = rule?.policy ?? config.groupPolicy;
			if (policy === "disabled") return false;
			if (config.requireMention && !mentionsBot(message?.mentions)) return false;
			if (policy === "allowlist") {
				if (!admin) {
					const list = rule?.allowlist?.length ? rule.allowlist : config.allowedUsers.split(",").map((s) => s.trim()).filter(Boolean);
					if (!list.includes(openId)) return false;
				}
			} else if (policy === "blacklist") {
				if ((rule?.blacklist ?? []).includes(openId)) return false;
			} else if (policy === "admin_only") {
				if (!admin) return false;
			}
			// policy === "open": allow
		} else if (!allowlistAllows(openId)) {
			return false;
		}
		return true;
	}
	function allowlistAllows(openId) {
		if (config.allowAllUsers) return true;
		if (!openId) return false;
		if (config.allowedUsers.trim() === "") return true; // empty allowlist = open (dev default)
		return config.allowedUsers.split(",").map((s) => s.trim()).filter(Boolean).includes(openId);
	}

	// --- message normalization ----------------------------------------------
	function normalizeTextEvent(event, message) {
		const messageType = message?.message_type ?? "text";
		const rawContent = message?.content ?? "{}";
		let text = "";
		const refs = [];
		try {
			const payload = JSON.parse(rawContent);
			if (messageType === "text") text = payload?.text ?? "";
			else if (messageType === "post") text = extractPostText(payload);
			else if (messageType === "interactive") text = extractInteractiveText(payload);
			else if (messageType === "image") { refs.push({ kind: "image", imageKey: payload?.image_key, fileKey: payload?.image_key }); text = "[收到图片]"; }
			else if (messageType === "file") { refs.push({ kind: "file", fileKey: payload?.file_key, name: payload?.file_name }); text = `[收到文件${payload?.file_name ? "：" + payload.file_name : ""}]`; }
			else if (messageType === "audio") { refs.push({ kind: "audio", fileKey: payload?.file_key }); text = "[收到语音]"; }
			else if (messageType === "media") { refs.push({ kind: "media", fileKey: payload?.file_key }); text = "[收到视频]"; }
			else text = "[收到不支持的消息类型]";
		} catch {
			text = "[消息解析失败]";
		}
		// Strip Feishu @mention placeholders (@_user_1, @_all) before the agent sees them.
		text = text.replace(/@_user_\d+/g, "").replace(/@_all/g, "").replace(/\s{2,}/g, " ").trim();
		return { text, refs, messageId: message?.message_id };
	}
	function extractPostText(payload) {
		const out = [];
		const walk = (v) => {
			if (v == null) return;
			if (typeof v === "string") { out.push(v); return; }
			if (Array.isArray(v)) { v.forEach(walk); return; }
			if (typeof v === "object") {
				if (typeof v.text === "string") out.push(v.text);
				for (const k of Object.keys(v)) if (k !== "text") walk(v[k]);
			}
		};
		walk(payload);
		return out.join("");
	}
	function extractInteractiveText(payload) {
		return JSON.stringify(payload);
	}

	// --- burst batching -----------------------------------------------------
	function flushBatch(chatId) {
		const b = batchState.get(chatId);
		batchState.delete(chatId);
		if (!b || b.text.trim() === "") return;
		const holder = chats.get(chatId);
		if (!holder) return;
		holder.agent.followup(createUserMessage({
			content: [{ type: "text", text: b.text }],
			source: { kind: "user" }
		}));
	}
	function dispatchText(chatId, text) {
		if (!text || text.trim() === "") return;
		if (config.textBatchDelayMs <= 0) {
			dispatchImmediate(chatId, text);
			return;
		}
		const prev = batchState.get(chatId);
		if (prev && prev.timer) clearTimeout(prev.timer);
		const joined = prev ? prev.text + "\n" + text : text;
		if (joined.length >= config.textBatchMaxChars || (prev?.count ?? 0) + 1 >= config.textBatchMaxMessages) {
			batchState.delete(chatId);
			dispatchImmediate(chatId, joined);
			return;
		}
		const b = { text: joined, count: (prev?.count ?? 0) + 1, timer: null };
		b.timer = setTimeout(() => flushBatch(chatId), config.textBatchDelayMs);
		batchState.set(chatId, b);
	}
	function dispatchImmediate(chatId, text) {
		ensureAgent(chatId).then((holder) => {
			holder.agent.followup(createUserMessage({
				content: [{ type: "text", text }],
				source: { kind: "user" }
			}));
		}).catch((e) => log(`[feishu] dispatch: ${e instanceof Error ? e.message : e}\n`));
	}

	// --- agent lifecycle ----------------------------------------------------
	async function ensureAgent(chatId) {
		let holder = chats.get(chatId);
		if (holder) return holder;
		const selection = ctx.get("agentDefaultModel").currentSelection();
		const agents = ctx.get("agents");
		const agentOptions = { provider: selection.provider, model: selection.model };
		const setup = (agentCtx) => {
			// installModelSelection returns a disposer, not an AgentSetupCommit —
			// return nothing so the factory doesn't treat it as a commit.
			installModelSelection(agentCtx, { current: selection, assembled: void 0 });
			// Tool whitelist: restrict the agent to the configured tools.
			if (config.allowedTools?.length) {
				try {
					agentCtx.tools.restrict({ allow: config.allowedTools });
				} catch (e) {
					log(`[feishu] tools.restrict: ${e instanceof Error ? e.message : e}\n`);
				}
			}
			// Dangerous command confirmation: shell commands matching the patterns
			// must be approved via an interactive card before they may run. The
			// `tools/pre-execute` waterfall returns `{ kind: "ask" }`, which routes
			// through the approval seam to the Feishu approval card. When cards are
			// disabled or no approval channel exists, the ask degrades to a deny, so
			// dangerous commands are blocked by default.
			if (config.dangerousCommands?.length) {
				const patterns = config.dangerousCommands.map((p) => new RegExp(p, "i"));
				const shellTools = new Set(["bash", "pwsh", "bash_persistent", "pwsh_persistent"]);
				agentCtx.on("tools/pre-execute", (exec, next) => {
					if (!shellTools.has(exec.name)) return next();
					const cmd = JSON.stringify(exec.arguments ?? "");
					for (const re of patterns) {
						if (re.test(cmd)) {
							const preview = cmd.length > 200 ? cmd.slice(0, 200) + "…" : cmd;
							return { kind: "ask", reason: `命令匹配危险规则「${re.source}」\n命令：\`${preview}\`` };
						}
					}
					return next();
				});
			}
		};
		// Resume a persisted session when we know its id, else create a fresh one.
		let handle;
		if (state.chats[chatId]) {
			log(`[feishu] resuming agent for chat ${chatId}\n`);
			handle = await agents.resume({
				resumeSessionId: SessionId(state.chats[chatId]),
				agentOptions,
				setup
			});
		} else {
			const cwd = chatWorkspace(chatId);
			log(`[feishu] creating agent for chat ${chatId} (cwd ${cwd}, model ${selection.provider}/${selection.model})\n`);
			handle = await agents.create({
				sessionId: SessionId(`feishu-${chatId}-${randomUUID()}`),
				meta: { cwd },
				agentOptions,
				setup
			});
			state.chats[chatId] = handle.agent.session.id;
			persistState();
		}
		holder = new ChatAgent(handle, chatId, clientRef, config);
		bySession.set(handle.agent.session.id, holder);
		chats.set(chatId, holder);
		installInteractionProviders(holder);
		return holder;
	}

	// --- approval + ask-user cards ------------------------------------------
	const pendingApprovals = new Map();
	const pendingQuestions = new Map();
	/** Send an interactive approval card; returns a promise resolving to the outcome. */
	function askApprovalCard(holder, req) {
		return new Promise((resolve) => {
			const id = randomUUID();
			const cleanup = () => {
				req.signal?.removeEventListener("abort", onAbort);
				pendingApprovals.delete(id);
			};
			const onAbort = () => {
				cleanup();
				resolve("cancelled");
			};
			if (req.signal) req.signal.addEventListener("abort", onAbort, { once: true });
			pendingApprovals.set(id, { resolve: (o) => { cleanup(); resolve(o); } });
			const card = buildApprovalCard(id, req);
			holder.send("interactive", card).catch(() => {
				cleanup();
				resolve("unavailable");
			});
		});
	}
	function buildApprovalCard(id, req) {
		return {
			config: { wide_screen_mode: true },
			header: { template: "blue", title: { tag: "plain_text", content: "需要你的审批" } },
			elements: [
				{ tag: "div", text: { tag: "lark_md", content: `工具 **${req.toolName}** 请求执行。\n${req.reason ? "原因：`" + req.reason + "`" : ""}` } },
				{
					tag: "action",
					actions: [
						{ tag: "button", text: { tag: "plain_text", content: "批准一次" }, type: "primary", value: { k: "fs_approval", id, choice: "allow" } },
						{ tag: "button", text: { tag: "plain_text", content: "拒绝" }, type: "danger", value: { k: "fs_approval", id, choice: "deny" } }
					]
				}
			]
		};
	}
	/** Provider for the `ask_user_question` tool rendered as a Feishu card. */
	function makeQuestionsProvider() {
		return {
			ask(request) {
				return new Promise((resolve) => {
					const qid = randomUUID();
					const settle = (answers) => { pendingQuestions.delete(qid); resolve({ answers }); };
					const onAbort = () => { pendingQuestions.delete(qid); resolve({ answers: [] }); };
					if (request.signal) request.signal.addEventListener("abort", onAbort, { once: true });
					pendingQuestions.set(qid, settle);
					const q = request.questions[0];
					const holder = request.agent ? bySession.get(request.agent.session.id) : null;
					if (!holder) { settle([]); return; }
					const options = (q.options ?? []).map((opt, i) => ({
						tag: "button",
						text: { tag: "plain_text", content: opt.label },
						type: i === 0 ? "primary" : "default",
						value: { k: "fs_question", id: qid, qindex: 0, oindex: i }
					}));
					holder.send("interactive", {
						config: { wide_screen_mode: true },
						header: { template: "grey", title: { tag: "plain_text", content: q.header || "请确认" } },
						elements: [
							{ tag: "div", text: { tag: "lark_md", content: q.question } },
							options.length ? { tag: "action", actions: options } : null
						].filter(Boolean)
					}).catch(() => settle([]));
				});
			}
		};
	}
	/** Register approval + ask-user interaction providers for one agent. */
	function installInteractionProviders(holder) {
		if (config.enableCards === false) return;
		const approval = ctx.get("approval");
		if (approval !== void 0) {
			holder.agent.ctx.on("approval/request", (req, next) => {
				if (req.signal?.aborted === true) return Promise.resolve("cancelled");
				return askApprovalCard(holder, req);
			});
		}
		const userQuestions = ctx.get("userQuestions");
		if (userQuestions !== void 0 && !questionsProviderInstalled) {
			questionsProviderInstalled = true;
			userQuestions.registerProvider(makeQuestionsProvider());
		}
	}
	let questionsProviderInstalled = false;

	// --- reply streaming ----------------------------------------------------
	ctx.on("session/event", (session, event) => {
		if (event.type !== "assistant/message") return;
		const text = assistantText(event.data.message);
		if (text === "") return;
		const holder = bySession.get(session.id);
		if (holder === void 0) return;
		log(`[feishu] assistant reply -> chat ${holder.chatId}: ${text.slice(0, 80)}\n`);
		holder.reply(text).catch((e) => holder.log("reply error", e));
	});

	// --- card action routing ------------------------------------------------
	// --- workspace switching (no typing: picker card) -----------------------
	function sendWorkspacePicker(holder, chatId) {
		const current = chatWorkspace(chatId);
		const list = config.workspaces ?? [];
		const actions = list.map((ws, i) => ({
			tag: "button",
			text: { tag: "plain_text", content: ws.name },
			type: i === 0 ? "primary" : "default",
			value: { k: "fs_workspace", index: i }
		}));
		holder.send("interactive", {
			config: { wide_screen_mode: true },
			header: { template: "turquoise", title: { tag: "plain_text", content: "选择工作区" } },
			elements: [
				{ tag: "div", text: { tag: "lark_md", content: `当前工作区：\`${current}\`\n点击下方按钮切换：` } },
				actions.length
					? { tag: "action", actions }
					: { tag: "div", text: { tag: "plain_text", content: "尚未配置任何工作区。启动时用 --workspaces-file <json> 提供 [{name,path}]。" } }
			]
		}).catch((e) => holder.log("workspace picker error", e));
	}
	/** Show a card to pick which bot configuration to switch to. */
	function sendBotPicker(holder) {
		const list = config.bots ?? [];
		const actions = list.map((b, i) => ({
			tag: "button",
			text: { tag: "plain_text", content: b.name },
			type: i === 0 ? "primary" : "default",
			value: { k: "fs_bot", index: i }
		}));
		holder.send("interactive", {
			config: { wide_screen_mode: true },
			header: { template: "blue", title: { tag: "plain_text", content: "选择机器人" } },
			elements: [
				{ tag: "div", text: { tag: "lark_md", content: `当前：\`${config.appId}\`\n点击下方按钮切换机器人（会重连）：` } },
				actions.length
					? { tag: "action", actions }
					: { tag: "div", text: { tag: "plain_text", content: "尚未配置其他机器人。启动时用 --bots-file <json> 提供 [{name,appId,appSecret,domain}]。" } }
			]
		}).catch((e) => holder.log("bot picker error", e));
	}
	/** Dispose the chat's agent and re-create a fresh one under the new cwd. */
	async function switchWorkspace(chatId, ws) {
		const holder = chats.get(chatId);
		if (holder) {
			await holder.handle.dispose().catch(() => {});
			chats.delete(chatId);
			bySession.delete(holder.agent.session.id);
		}
		state.workspaces = state.workspaces ?? {};
		state.workspaces[chatId] = { name: ws.name, path: ws.path };
		delete state.chats[chatId]; // fresh session under the new cwd
		persistState();
		const h = await ensureAgent(chatId);
		await h.send("text", { text: `✅ 工作区已切换：${ws.name}\n\`${ws.path}\`` });
	}

	function handleCardAction(event) {
		const value = event?.action?.value ?? {};
		const chatId = event?.open_chat_id ?? event?.action?.open_chat_id;
		if (value.k === "fs_approval") {
			const pending = pendingApprovals.get(value.id);
			if (pending) pending.resolve(value.choice === "allow" ? "allowed-once" : "rejected");
		} else if (value.k === "fs_question") {
			const settle = pendingQuestions.get(value.id);
			if (settle) settle([{ id: "q0", selected: [String(value.oindex)] }]);
		} else if (value.k === "fs_workspace") {
			const ws = config.workspaces?.[value.index];
			if (ws && chatId) switchWorkspace(chatId, ws).catch((e) => log(`[feishu] workspace switch: ${e instanceof Error ? e.message : e}\n`));
		} else if (value.k === "fs_bot") {
			const bot = config.bots?.[value.index];
			if (bot) reconnectBot(bot).catch((e) => log(`[feishu] bot switch: ${e instanceof Error ? e.message : e}\n`));
		}
	}

	// --- restart / autostart (plugin-native, no external scripts) -----------
	/** Re-launch this process with the same command line, then exit. */
	function restartBot() {
		const [node, ...rest] = process.argv;
		const child = spawn(node, rest, { detached: true, stdio: "ignore" });
		child.unref();
		process.exit(0);
	}
	/** Windows Startup folder path (empty on non-Windows). */
	function startupFolder() {
		if (process.platform !== "win32") return "";
		return join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
	}
	/** Install/remove a login auto-start entry that launches this bot. */
	function setAutostart(enabled) {
		const dir = startupFolder();
		if (!dir) return { ok: false, reason: "auto-start is only supported on Windows" };
		const file = join(dir, "dsh-feishu.cmd");
		if (!enabled) {
			if (existsSync(file)) unlinkSync(file);
			return { ok: true, file };
		}
		const q = (s) => `""${s}""`;
		const [script, ...args] = process.argv.slice(1);
		const logPath = join(config.workspaceRoot, "dsh-feishu.log");
		const cmd = `@echo off\r\nstart "dsh-feishu" /min cmd /c "node ${q(script)} ${args.map(q).join(" ")} > ${q(logPath)} 2>&1"\r\n`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(file, cmd, "utf8");
		return { ok: true, file };
	}

	// --- slash commands -----------------------------------------------------
	const COMMANDS = ["/workspace", "/bot", "/help", "/status", "/debug", "/reset", "/restart", "/autostart"];
	function showHelp(holder) {
		holder.send("text", {
			text: "可用命令：\n/workspace - 切换工作区\n/bot - 切换机器人\n/status - 查看当前状态\n/debug - 诊断信息\n/reset - 重置当前会话\n/restart - 重启飞书频道\n/autostart on|off - 开启/关闭开机自启\n/help - 显示本帮助"
		}).catch((e) => holder.log("help error", e));
	}
	function showStatus(holder, chatId) {
		const selection = ctx.get("agentDefaultModel").currentSelection();
		holder.send("text", {
			text: `📊 状态\n工作区：\`${chatWorkspace(chatId)}\`\n模型：${selection.provider}/${selection.model}\n会话：${holder.agent.session.id}`
		}).catch((e) => holder.log("status error", e));
	}
	function showDebug(holder, chatId) {
		const selection = ctx.get("agentDefaultModel").currentSelection();
		holder.send("text", {
			text: `🔧 诊断\n模式：${config.mode}\napp_id：${config.appId}\ndomain：${config.domain}\n工作区：\`${chatWorkspace(chatId)}\`\n模型：${selection.provider}/${selection.model}\n活跃会话数：${chats.size}\n群策略：${config.groupPolicy}\nrequireMention：${config.requireMention}\nallowBots：${config.allowBots}`
		}).catch((e) => holder.log("debug error", e));
	}
	async function resetSession(chatId) {
		const holder = chats.get(chatId);
		if (holder) {
			await holder.handle.dispose().catch(() => {});
			chats.delete(chatId);
			bySession.delete(holder.agent.session.id);
		}
		delete state.chats[chatId];
		persistState();
		const h = await ensureAgent(chatId);
		await h.send("text", { text: "✅ 会话已重置，重新开始。" });
	}
	function showUnknownCommand(holder, cmd) {
		holder.send("text", {
			text: `未知命令 \`${cmd}\`。可用命令：${COMMANDS.join("、")}（发 /help 查看说明）`
		}).catch((e) => holder.log("unknown command error", e));
	}
	/** Route a slash command; returns true when handled. */
	function handleCommand(holder, chatId, cmd, text) {
		switch (cmd) {
			case "/workspace": sendWorkspacePicker(holder, chatId); return true;
			case "/bot": sendBotPicker(holder); return true;
			case "/help": showHelp(holder); return true;
			case "/status": showStatus(holder, chatId); return true;
			case "/debug": showDebug(holder, chatId); return true;
			case "/reset": resetSession(chatId).catch((e) => log(`[feishu] reset: ${e instanceof Error ? e.message : e}\n`)); return true;
			case "/restart": restartBot(); return true;
			case "/autostart": {
				const arg = (text.split(/\s+/)[1] || "").toLowerCase();
				const res = setAutostart(arg !== "off");
				holder.send("text", {
					text: res.ok
						? (arg === "off" ? "✅ 已关闭开机自启" : `✅ 已开启开机自启\n${res.file}`)
						: `❌ ${res.reason}`
				}).catch((e) => holder.log("autostart error", e));
				return true;
			}
			default: showUnknownCommand(holder, cmd); return true;
		}
	}

	// --- inbound message handling -------------------------------------------
	function handleMessage(event) {
		const message = event?.message;
		if (!message) return;
		if (isDuplicate(message.message_id)) return;
		if (!admit(event, message)) return;
		const chatId = message.chat_id ?? event?.chat_id;
		if (!chatId) return;
		const { text, refs } = normalizeTextEvent(event, message);
		log(`[feishu] handling message in chat ${chatId}: ${text.slice(0, 60)}\n`);
		// Slash commands are handled locally, not sent to the agent.
		if (text.startsWith("/")) {
			const cmd = text.split(/\s+/)[0].toLowerCase();
			ensureAgent(chatId).then((holder) => handleCommand(holder, chatId, cmd, text))
				.catch((e) => log(`[feishu] command: ${e instanceof Error ? e.message : e}\n`));
			return;
		}
		// Best-effort: add a processing reaction on the user's message.
		ensureAgent(chatId).then((holder) => {
			const reactionIdPromise = holder.addReaction(message.message_id);
			dispatchText(chatId, text);
			// Clear the reaction when this batch settles (rough: after a delay).
			reactionIdPromise.then((rid) => {
				if (rid) setTimeout(() => holder.clearReaction(message.message_id, rid), 5000);
			});
		}).catch((e) => log(`[feishu] handleMessage: ${e instanceof Error ? e.message : e}\n`));
	}
	/** Unified entry for websocket and webhook event payloads. */
	function handleIncoming(data) {
		const type = data?.header?.event_type ?? data?.type;
		if (type) log(`[feishu] event: ${type}\n`);
		try {
			if (type === "im.message.receive_v1") handleMessage(data.event);
			else if (type === "card.action.trigger") handleCardAction(data.event);
		} catch (e) {
			log(`[feishu] handleIncoming: ${e instanceof Error ? e.message : e}\n`);
		}
	}

	// --- webhook transport --------------------------------------------------
	const rateLimiter = makeRateLimiter(config.rateLimitMax, 60 * 1000);
	function startWebhook() {
		const listenPath = config.path && config.path.trim() !== "" ? config.path : "/";
		const listenPathNoSlash = listenPath.endsWith("/") ? listenPath.slice(0, -1) : listenPath;
		const server = createServer((req, res) => {
			if (req.url !== listenPath && req.url !== listenPathNoSlash) {
				res.writeHead(404);
				res.end("not found");
				return;
			}
			const chunks = [];
			let size = 0;
			let body = "";
			req.on("data", (c) => {
				size += c.length;
				if (size > config.maxWebhookBodyBytes) {
					res.writeHead(413);
					res.end("payload too large");
					req.destroy();
					return;
				}
				chunks.push(c);
			});
			req.on("end", () => {
				body = Buffer.concat(chunks).toString("utf8");
				const remoteIp = req.socket.remoteAddress ?? "";
				// Content-Type enforcement.
				const ctype = (req.headers["content-type"] ?? "").split(";")[0].trim();
				if (ctype !== "application/json") { res.writeHead(415); res.end("unsupported media type"); return; }
				// Rate limit per (appId,path,ip).
				if (!rateLimiter(`${config.appId}:${req.url}:${remoteIp}`)) {
					res.writeHead(429);
					res.end("rate limited");
					return;
				}
				// Verification token (defense in depth).
				let parsed;
				try {
					parsed = JSON.parse(body);
				} catch {
					res.writeHead(400);
					res.end("bad json");
					return;
				}
				if (config.verificationToken) {
					const token = parsed?.header?.token ?? parsed?.token;
					if (token !== config.verificationToken) { res.writeHead(401); res.end("bad token"); return; }
				}
				// Encrypt-key signature over the raw body.
				if (config.encryptKey) {
					const sig = req.headers["x-lark-signature"];
					const ts = String(req.headers["x-lark-request-timestamp"] ?? "");
					const nonce = String(req.headers["x-lark-request-nonce"] ?? "");
					if (!sig || !timingSafeEqual(sig, computeSignature(config.encryptKey, ts, nonce, body))) {
						res.writeHead(401);
						res.end("bad signature");
						return;
					}
				}
				// URL verification challenge.
				if (parsed?.type === "url_verification") {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ challenge: parsed.challenge }));
					return;
				}
				// Encrypted payloads are not supported.
				if (parsed?.encrypt) { res.writeHead(400); res.end("encrypted webhook unsupported"); return; }
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ code: 0 }));
				handleIncoming(parsed);
			});
		});
		server.listen(config.port, config.host, () => {
			log(`[feishu] webhook listening on ${config.host}:${config.port}${listenPath}\n`);
		});
		return server;
	}
	/** Long-connection transport (no public callback URL). */
	let wsClient = null;
	let server = null;
	function startLongConn() {
		wsClient = new lark.WSClient({
			appId: config.appId,
			appSecret: config.appSecret,
			domain: config.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
			onReady: () => log("[feishu] long connection ready\n"),
			onError: (err) => log(`[feishu] ws error: ${err instanceof Error ? err.message : String(err)}\n`)
		});
		wsClient.start({
			eventDispatcher: {
				invoke: (mergedData) => {
					// mergedData is the full event payload { schema, header, event }.
					handleIncoming(mergedData);
				}
			}
		});
		log("[feishu] long connection started\n");
	}
	function stopTransport() {
		try {
			if (wsClient) { wsClient.close?.(); wsClient = null; }
			if (server) { server.close(); server = null; }
		} catch {
			/* ignore */
		}
	}
	function startTransport() {
		if (config.mode === "longconn") startLongConn();
		else server = startWebhook();
	}
	// --- local config page (bots + workspaces editor) ----------------------
	function saveBotsFile() {
		if (!config.botsFile) return;
		try {
			mkdirSync(dirname(config.botsFile), { recursive: true });
			writeFileSync(config.botsFile, JSON.stringify(config.bots, null, 2), "utf8");
		} catch (e) {
			log(`[feishu] save bots file: ${e instanceof Error ? e.message : e}\n`);
		}
	}
	function saveWorkspacesFile() {
		if (!config.workspacesFile) return;
		try {
			mkdirSync(dirname(config.workspacesFile), { recursive: true });
			writeFileSync(config.workspacesFile, JSON.stringify(config.workspaces, null, 2), "utf8");
		} catch (e) {
			log(`[feishu] save workspaces file: ${e instanceof Error ? e.message : e}\n`);
		}
	}
	function startConfigServer() {
		let onboardState = null;
		const cfgServer = createServer((req, res) => {
			const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
			if (req.method === "GET" && url.pathname === "/") {
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(CONFIG_PAGE_HTML);
			} else if (req.method === "GET" && url.pathname === "/api/config") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ bots: config.bots, workspaces: config.workspaces }));
			} else if (req.method === "POST" && url.pathname === "/api/config") {
				let body = "";
				req.on("data", (c) => (body += c));
				req.on("end", () => {
					try {
						const data = JSON.parse(body);
						if (Array.isArray(data.bots)) { config.bots = data.bots; saveBotsFile(); }
						if (Array.isArray(data.workspaces)) { config.workspaces = data.workspaces; saveWorkspacesFile(); }
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ ok: true }));
					} catch (e) {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
					}
				});
			} else if (req.method === "POST" && url.pathname === "/api/onboard/begin") {
				let body = "";
				req.on("data", (c) => (body += c));
				req.on("end", () => {
					let domain = "feishu";
					try { domain = JSON.parse(body).domain === "lark" ? "lark" : "feishu"; } catch { /* default */ }
					beginRegistration(domain).then((b) => {
						onboardState = { domain, deviceCode: b.deviceCode, interval: b.interval, expireIn: b.expireIn };
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ qrUrl: b.qrUrl, interval: b.interval, expireIn: b.expireIn }));
					}).catch((e) => {
						res.writeHead(500, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
					});
				});
			} else if (req.method === "POST" && url.pathname === "/api/onboard/poll") {
				if (!onboardState) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ status: "error", error: "no active onboarding" }));
					return;
				}
				pollOnce(onboardState.domain, onboardState.deviceCode).then((r) => {
					if (r.status === "success") onboardState = null;
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify(r));
				}).catch((e) => {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ status: "error", error: e instanceof Error ? e.message : String(e) }));
				});
			} else {
				res.writeHead(404);
				res.end("not found");
			}
		});
		cfgServer.listen(config.configPort, "127.0.0.1", () => {
			log(`[feishu] config page: http://127.0.0.1:${config.configPort}\n`);
		});
		return cfgServer;
	}
	/** Switch to a different bot configuration (reconnect with new credentials). */
	async function reconnectBot(bot) {
		stopTransport();
		config.appId = bot.appId;
		config.appSecret = bot.appSecret;
		config.domain = bot.domain ?? "feishu";
		clientRef.current = new lark.Client({
			appId: config.appId,
			appSecret: config.appSecret,
			appType: lark.AppType.SelfBuild,
			domain: config.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu
		});
		// Reset bot identity so @mention gating re-resolves for the new bot.
		botIdentity = { openId: config.botOpenId, userId: config.botUserId, name: config.botName };
		botResolvePromise = null;
		if (!botIdentity.openId && !botIdentity.name) resolveBotIdentity();
		startTransport();
		log(`[feishu] switched to bot ${bot.name} (${config.appId})\n`);
	}

	// --- startup ------------------------------------------------------------
	// Resolve bot identity in the background for @mention gating.
	if (config.botOpenId || config.botName) {
		// already configured; nothing to resolve
	} else {
		resolveBotIdentity();
	}
	startTransport();
	// Local config page (bots + workspaces editor).
	startConfigServer();
	// Graceful shutdown.
	function shutdown() {
		stopTransport();
		process.exit(0);
	}
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}
//#endregion
export { Config, apply, inject, internals, name };
