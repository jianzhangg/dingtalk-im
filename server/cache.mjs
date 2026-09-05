// Tiny JSON file cache: conversations + per-conversation messages (cap 150).
// Local-only personal data. Never commit data/.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = process.env.DWS_IM_DATA_DIR || join(homedir(), ".dingtalk-im", "data");
const file = join(root, "cache.json");

let saveTimer = null;
export let cache = { conversations: [], messages: {}, members: {}, readAt: {}, convIds: {}, updatedAt: null };

export function loadCache() {
  try {
    cache = JSON.parse(readFileSync(file, "utf8"));
    cache.conversations ||= [];
    cache.messages ||= {};
    cache.members ||= {};
    cache.readAt ||= {};
    cache.convIds ||= {};
  } catch {
    cache = { conversations: [], messages: {}, members: {}, readAt: {}, convIds: {}, updatedAt: null };
  }
  return cache;
}

export function saveCacheSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      mkdirSync(root, { recursive: true });
      cache.updatedAt = new Date().toISOString();
      writeFileSync(file, JSON.stringify(cache), "utf8");
    } catch {
      // cache is best-effort
    }
  }, 500);
}

export function putMessages(key, list) {
  const seen = new Map((cache.messages[key] || []).map((m) => [msgKey(m), m]));
  for (const m of list) seen.set(msgKey(m), m);
  cache.messages[key] = [...seen.values()].slice(-150);
  saveCacheSoon();
}

export function msgKey(m) {
  return String(m?.msgId || m?.messageId || m?.id || JSON.stringify(m).slice(0, 80));
}
