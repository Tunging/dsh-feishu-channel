/**
 * @hiker8668/dsh-feishu/startup — the Feishu surface's command-line provider.
 * Two entry points: `setup` (scan-to-create onboarding that saves credentials
 * to `$DSH_HOME/feishu-credentials.json`) and the run command (credentials from
 * CLI flags, falling back to the saved file).
 * @module @hiker8668/dsh-feishu/startup
 */
import type { Context } from '@deepseek-ai/cordis';
/** Stable Cordis plugin name. */
export declare const name = "feishu-startup";
/** Services required before the config can be resolved. */
export declare const inject: string[];
/** Service provided by this plugin and injected by the runner. */
export declare const FEISHU_STARTUP_SERVICE = "feishuStartup";
/** The parsed Feishu surface config. */
export interface FeishuStartup {
    appId: string;
    appSecret: string;
    mode: 'webhook' | 'longconn';
    port: number;
    host: string;
    path: string;
    domain: 'feishu' | 'lark';
    workspaceRoot: string;
    stateFile: string;
    configPort: number;
    botsFile: string;
    workspacesFile: string;
    workspaces: {
        name: string;
        path: string;
    }[];
    bots: {
        name: string;
        appId: string;
        appSecret: string;
        domain: string;
    }[];
    botOpenId?: string;
    botUserId?: string;
    botName?: string;
    allowedUsers: string;
    allowAllUsers: boolean;
    groupPolicy: string;
    requireMention: boolean;
    allowBots: string;
    verificationToken?: string;
    encryptKey?: string;
    enableCards: boolean;
    enableReactions: boolean;
    textBatchDelayMs: number;
}
/**
 * Parse and provide the Feishu config as an ordinary Cordis service.
 */
export declare function apply(ctx: Context): void;
export {};
