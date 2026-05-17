import type { ChannelLoginWithQrStartResult, ChannelLoginWithQrWaitResult } from "./types.js";

// WhatsApp source channel removed from v0; these stubs keep the runtime
// `channel.whatsapp` slot shape intact so the WhatsApp extension can still be
// loaded by tests while the extension itself is retired in a later cut.
const NOT_AVAILABLE = "WhatsApp source channel is not available in this build.";

export async function webAuthExists(_authDir?: string): Promise<boolean> {
  return false;
}

export function getWebAuthAgeMs(_authDir?: string): number | null {
  return null;
}

export function logWebSelfId(_authDir?: string): void {
  // no-op
}

export function readWebSelfId(_authDir?: string): { e164: string | null; jid: string | null } {
  return { e164: null, jid: null };
}

export async function logoutWeb(_params: unknown): Promise<boolean> {
  return false;
}

export function getActiveWebListener(): null {
  return null;
}

export async function sendMessageWhatsApp(
  _to: string,
  _text: string,
  _opts?: unknown,
): Promise<never> {
  throw new Error(NOT_AVAILABLE);
}

export async function sendPollWhatsApp(
  _to: string,
  _poll: unknown,
  _opts?: unknown,
): Promise<never> {
  throw new Error(NOT_AVAILABLE);
}

export async function loginWeb(
  _force?: boolean,
  _channel?: unknown,
  _runtime?: unknown,
  _accountId?: string,
): Promise<void> {
  throw new Error(NOT_AVAILABLE);
}

export async function startWebLoginWithQr(_params: {
  timeoutMs?: number;
  force?: boolean;
  accountId?: string;
}): Promise<ChannelLoginWithQrStartResult> {
  return { message: NOT_AVAILABLE };
}

export async function waitForWebLogin(_params: {
  timeoutMs?: number;
  accountId?: string;
}): Promise<ChannelLoginWithQrWaitResult> {
  return { connected: false, message: NOT_AVAILABLE };
}

export async function monitorWebChannel(..._args: unknown[]): Promise<never> {
  throw new Error(NOT_AVAILABLE);
}
