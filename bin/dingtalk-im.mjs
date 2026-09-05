#!/usr/bin/env node
// npx entry: ensure dws CLI -> ensure login -> start local IM server.
//   npx dingtalk-im [--port 3777] [--no-open] [--data-dir <path>]
import { spawnSync, spawn } from "node:child_process";
import { accessSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "server", "server.mjs");
const DWS_INSTALL_SH = "https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.sh";
const DWS_INSTALL_PS1 = "https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.ps1";

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const PORT = opt("--port", process.env.PORT || "3777");
const NO_OPEN = args.includes("--no-open");
const DATA_DIR = opt("--data-dir", process.env.DWS_IM_DATA_DIR || join(homedir(), ".dingtalk-im", "data"));

function dwsCmd() {
  if (process.env.DWS_BIN) return { cmd: process.env.DWS_BIN, prefix: [], shell: false };
  if (platform() === "win32") {
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

function dwsOk() {
  try {
    const d = dwsCmd();
    const r = spawnSync(d.cmd, [...d.prefix, "version", "-f", "json", "-y"], { encoding: "utf8", timeout: 20000, shell: d.shell });
    return r.status === 0;
  } catch {
    return false;
  }
}

function installDws() {
  console.log("[dingtalk-im] dws CLI not found, installing...");
  let r;
  if (platform() === "win32") {
    r = spawnSync("powershell", ["-NoProfile", "-Command", `irm ${DWS_INSTALL_PS1} | iex`], { stdio: "inherit", timeout: 300000 });
  } else {
    r = spawnSync("sh", ["-c", `curl -fsSL ${DWS_INSTALL_SH} | sh`], { stdio: "inherit", timeout: 300000 });
  }
  if (r.status !== 0) {
    console.error("[dingtalk-im] auto install failed. Install manually:");
    console.error(`  npm i -g dingtalk-workspace-cli   (or see https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli)`);
    process.exit(1);
  }
}

function loggedIn() {
  try {
    const d = dwsCmd();
    const r = spawnSync(d.cmd, [...d.prefix, "auth", "status", "-f", "json", "-y"], { encoding: "utf8", timeout: 30000, shell: d.shell });
    if (r.status !== 0) return false;
    const j = JSON.parse(r.stdout || "{}");
    return j.authenticated === true && j.token_valid !== false;
  } catch {
    return false;
  }
}

function doLogin() {
  console.log("[dingtalk-im] not logged in, opening login (browser may pop up)...");
  const d = dwsCmd();
  const r = spawnSync(d.cmd, [...d.prefix, "auth", "login"], { stdio: "inherit", shell: d.shell });
  if (r.status !== 0) {
    console.error("[dingtalk-im] login failed or cancelled. Run `dws auth login` manually and retry.");
    process.exit(1);
  }
}

function openBrowser(url) {
  if (NO_OPEN) return;
  const p = platform();
  const cmd = p === "win32" ? "cmd" : p === "darwin" ? "open" : "xdg-open";
  const a = p === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, a, { stdio: "ignore", detached: true }).unref();
  } catch {}
}

if (!dwsOk()) installDws();
if (!dwsOk()) {
  console.error("[dingtalk-im] dws still not usable after install. Check PATH and retry.");
  process.exit(1);
}
if (!loggedIn()) doLogin();

const url = `http://127.0.0.1:${PORT}`;
console.log(`[dingtalk-im] starting on ${url} (data: ${DATA_DIR})`);
openBrowser(url);
const child = spawn(process.execPath, [SERVER], {
  stdio: "inherit",
  env: { ...process.env, PORT, DWS_IM_DATA_DIR: DATA_DIR },
});
child.on("exit", (c) => process.exit(c ?? 0));
