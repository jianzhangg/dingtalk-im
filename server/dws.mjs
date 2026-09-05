// Allowlisted dws invocations. Only JSON output, 30s timeout, no shell.
import { execFileSync } from "node:child_process";
import { accessSync } from "node:fs";
import { join } from "node:path";

function resolveDws() {
  if (process.env.DWS_BIN) return { cmd: process.env.DWS_BIN, prefix: [], shell: false };
  if (process.platform === "win32") {
    // npm shim (dws.cmd/dws.ps1) can't be execFile'd directly; run the real entry with node.
    const js = join(process.env.APPDATA || "", "npm", "node_modules", "dingtalk-workspace-cli", "bin", "dws.js");
    try {
      accessSync(js);
      return { cmd: process.execPath, prefix: [js], shell: false };
    } catch {
      return { cmd: "dws.cmd", prefix: [], shell: true };
    }
  }
  return { cmd: "dws", prefix: [], shell: false };
}

const DWS = resolveDws();
export const DWS_BIN = process.env.DWS_BIN || DWS.cmd;
export const DWS_PREFIX = DWS.prefix;
export const DWS_SHELL = DWS.shell;

// chat read/write + conversation/at-me/unread only. event goes via spawn (streaming).
const ALLOW = new Set([
  "chat message list-unread-conversations", // 原子口：会话级未读数/notificationOff（只读）
  "chat +conversation-list",
  "chat +messages-list",
  "chat +messages-list-direct",
  "chat +messages-send",
  "chat +messages-list-unread-conversations",
  "chat +unread-chats",
  "chat +at-me",
  "chat +conversation-info",
  "chat mark-read",
  "chat +conversation-mark-read",
  "chat +chat-members-list",
  "chat +conversation-info",
  "chat +messages-resource-url",
  "chat +messages-recall",
  "chat +messages-add-emoji",
  "chat message reply",
  "chat +messages-resource-download",
  "chat emotion list",
  "chat emotion send",
  "contact +me",
]);

export function assertAllowed(cmd, sub) {
  if (!ALLOW.has(`${cmd} ${sub}`)) throw new Error(`dws command not allowlisted: ${cmd} ${sub}`);
}

export function runDws(cmd, sub, args = [], execOpts = {}) {
  // 原子口 sub 可能多段（"message reply"），allowlist 按完整串匹配
  assertAllowed(cmd, String(sub || "").trim().replace(/\s+/g, " "));
  return runDwsRaw(cmd, sub, args, execOpts);
}

export function runDwsRaw(cmd, sub, args = [], execOpts = {}) {
  const parts = [cmd, ...String(sub || "").split(" ").filter(Boolean), ...(args || [])].filter((s) => s !== "" && s != null);
  const out = execFileSync(DWS.cmd, [...DWS.prefix, ...parts, "-f", "json", "-y"], {
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
    shell: DWS.shell,
    ...execOpts,
  });
  const text = out.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export function fmtTime(d = new Date(Date.now() - 7 * 864e5)) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function checkId(v, name = "id") {
  // 钉钉 ID 多为 base64（可含 + / = 垫尾），图片资源还有 $ 前缀，另兼容 userId/手机号形态
  if (typeof v !== "string" || !v || v.length > 256 || !/^[\w@.\-:/+=$]+$/.test(v)) {
    throw new Error(`invalid ${name}`);
  }
  return v;
}

export function checkText(v) {
  if (typeof v !== "string" || !v.trim() || v.length > 5000) throw new Error("invalid text");
  return v;
}

// 文件名只留安全字符（防路径穿越）， rest 走 Content-Disposition 原名下载
export function checkFileName(v) {
  if (typeof v !== "string" || !v || v.length > 120) throw new Error("invalid name");
  const base = v.split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!base || base === "." || base === ".." || !/^[\w.\-()（）\[\] @+\u4e00-\u9fa5]+$/.test(base)) throw new Error("invalid name");
  return base;
}
