/**
 * @tunging/dsh-feishu — a Feishu (Lark) bot surface for DeepSeek Harness.
 * @module @tunging/dsh-feishu
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Stable Cordis plugin name. */
export declare const name = "feishu-runner";
/** Core services required before a turn can start. */
export declare const inject: string[];
/** Plugin config: the Feishu app credentials, transport, gating, and security. */
export interface Config {
    /** Feishu app id. */
    appId: string;
    /** Feishu app secret. */
    appSecret: string;
    /** Transport: 'webhook' (event subscription) or 'longconn' (WebSocket). */
    mode: string;
    /** Listen port for webhook mode. */
    port: number;
    /** Webhook bind address. */
    host: string;
    /** Webhook endpoint path. */
    path: string;
    /** 'feishu' (China) or 'lark' (International). */
    domain: string;
    /** Workspace root for fresh sessions. */
    workspaceRoot: string;
    /** Selectable workspaces for the /workspace picker card. */
    workspaces: {
        name: string;
        path: string;
    }[];
    /** Selectable bot configurations for the /bot picker card. */
    bots: {
        name: string;
        appId: string;
        appSecret: string;
        domain: string;
    }[];
    /** Bot open_id (for @mention gating). */
    botOpenId?: string;
    /** Bot user_id (for @mention gating). */
    botUserId?: string;
    /** Bot display name (for @mention gating). */
    botName?: string;
    /** Comma-separated open_id allowlist. */
    allowedUsers: string;
    /** Allow any Feishu user (dev only). */
    allowAllUsers: boolean;
    /** Group policy: 'open' | 'allowlist' | 'disabled'. */
    groupPolicy: string;
    /** Groups must @mention the bot. */
    requireMention: boolean;
    /** Accept peer bot messages: 'none' | 'mentions' | 'all'. */
    allowBots: string;
    /** Webhook verification token. */
    verificationToken?: string;
    /** Webhook signature encrypt key. */
    encryptKey?: string;
    /** Render approval/question cards. */
    enableCards: boolean;
    /** Show processing reactions. */
    enableReactions: boolean;
    /** Max chars per plain-text chunk. */
    maxTextChunk: number;
    /** Max chars per markdown post chunk. */
    maxMdChunk: number;
    /** Burst text debounce delay (ms). */
    textBatchDelayMs: number;
    /** Max messages merged per text batch. */
    textBatchMaxMessages: number;
    /** Max chars merged per text batch. */
    textBatchMaxChars: number;
    /** Message-id dedup TTL (ms). */
    dedupTtlMs: number;
    /** Max webhook body bytes. */
    maxWebhookBodyBytes: number;
    /** Webhook rate-limit per (app,path,ip) per 60s. */
    rateLimitMax: number;
    /** JSON file persisting chat_id -> sessionId. */
    stateFile: string;
    /** Local config page port. */
    configPort: number;
    /** Path to the bots JSON file (for the config page). */
    botsFile: string;
    /** Path to the workspaces JSON file (for the config page). */
    workspacesFile: string;
}
export declare const Config: z<Config>;
/** The process streams the runner writes to; tests substitute captures. */
export declare const internals: {
    stdout: {
        write(chunk: string): unknown;
    };
    stderr: {
        write(chunk: string): unknown;
    };
};
/**
 * Mount the Feishu surface: build the client, wire the transport, and drive
 * agents on incoming messages.
 */
export declare function apply(ctx: Context, config: Config): void;
export {};
