// Local-only DingTalk IM server. Serves ../sites/dingtalk-im + JSON API over dws.
// Run: node server.mjs   Open: http://127.0.0.1:3777   (never expose publicly)
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { runDws, fmtTime, checkId, checkText, checkFileName, DWS_BIN, DWS_PREFIX, DWS_SHELL, runDwsRaw } from "./dws.mjs";
import { cache, loadCache, putMessages, saveCacheSoon, msgKey } from "./cache.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 3777);
const HERE = dirname(fileURLToPath(import.meta.url));
// npx 包内 web/；开发时可用 DWS_IM_WEB_DIR 指向别处
const WEB_DIR = process.env.DWS_IM_WEB_DIR || join(HERE, "..", "web");
// npx 不写 CWD：缓存默认放用户家目录，可用 DWS_IM_DATA_DIR 覆盖
const DATA_DIR = process.env.DWS_IM_DATA_DIR || join(homedir(), ".dingtalk-im", "data");
const RES_DIR = join(DATA_DIR, "res");

loadCache();

let meCache = null;
let meAt = 0;
function getMe() {
  if (meCache && Date.now() - meAt < 3600e3) return meCache;
  const r = runDws("contact", "+me", []);
  meCache = r?.data || r;
  meAt = Date.now();
  return meCache;
}

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function serveStatic(req, res) {
  // 固定映射，不玩路径拼接：未知路径一律 404，避免 octet-stream 触发浏览器下载框
  const raw = decodeURIComponent(req.url.split("?")[0]);
  if (raw === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return true;
  }
  const file =
    raw === "/" || raw === "/index.html"
      ? join(WEB_DIR, "index.html")
      : raw === "/app.js"
        ? join(WEB_DIR, "app.js")
        : null;
  if (!file || !existsSync(file)) return false;
  const type = file.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8";
  res.writeHead(200, { "Content-Type": type });
  res.end(readFileSync(file));
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => ((s += c), s.length > 64 * 1024 && req.destroy()));
    req.on("end", () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function unwrapList(r) {
  if (Array.isArray(r)) return r;
  return r?.items || r?.list || r?.conversations || r?.messages || r?.data?.items || [];
}

// cid 开头 = 会话 openConversationId，有它一律走群式口子（--group/--chat-id），
// 不再按单聊/群聊区分：单聊在列表里同样有 cid，而 --open-dingtalk-id 只认用户 ID，传 cid 必报 target_type_mismatch
function isCid(id) {
  return /^cid/i.test(String(id || ""));
}

// 单聊传的是对端 ID，需要会话 openConversationId 的口子先解析（结果缓存）；已是 cid 直接用
function convOpenId(kind, id) {
  if (kind !== "direct" || isCid(id)) return id;
  cache.convIds = cache.convIds || {};
  if (!cache.convIds[id]) {
    const r = runDws("chat", "+conversation-info", ["--open-dingtalk-id", id]);
    const cid = r?.result?.conversationInfo?.openConversationId;
    if (!cid) throw new Error("no conversation for user");
    cache.convIds[id] = cid;
    saveCacheSoon();
  }
  return cache.convIds[id];
}

function byTimeAsc(a, b) {
  return new Date(a.createTime?.replace(" ", "T")) - new Date(b.createTime?.replace(" ", "T"));
}

// 最后一条预览：富媒体只留类型标签，不暴露 mediaId 原串
function previewText(m) {
  const t = String(m?.text || "");
  if (/^\[图片消息\]/.test(t)) return "[图片]";
  if (/^\[语音\]/.test(t)) return "[语音]";
  if (/^\[视频\]/.test(t)) return "[视频]";
  if (/^\[文件\]/.test(t)) return "[文件]";
  if (/^\[表情\]/.test(t)) return "[表情]";
  return t.slice(0, 60);
}

// GET /api/events -> SSE from `dws event consume` (DingTalk Stream long-conn, NDJSON).
function handleEvents(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  let child;
  try {
    child = spawn(DWS_BIN, [...DWS_PREFIX, "event", "consume", "user_im_message_receive_group_all", "user_im_message_receive_o2o_all", "-f", "ndjson", "--flatten", "-y"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: DWS_SHELL,
    });
  } catch (e) {
    // headers already sent: report in-band, don't throw (would crash server)
    try {
      res.write(`event: error\ndata: {"message":${JSON.stringify(String(e?.message || e))}}\n\n`);
    } catch {}
    return res.end();
  }
  let buf = "";
  child.stdout.on("data", (c) => {
    if (res.writableEnded) return;
    buf += c.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) {
        try {
          res.write(`data: ${line}\n\n`);
        } catch {
          break;
        }
      }
    }
  });
  const hb = setInterval(() => {
    if (res.writableEnded) return clearInterval(hb);
    try {
      res.write(": hb\n\n");
    } catch {
      clearInterval(hb);
    }
  }, 25_000);
  const done = () => {
    clearInterval(hb);
    try {
      child.kill();
    } catch {}
  };
  res.on("close", done);
  const errOut = (msg) => {
    clearInterval(hb);
    if (res.writableEnded) return;
    try {
      res.write(`event: error\ndata: {"message":${JSON.stringify(msg)}}\n\n`);
    } catch {}
    try {
      res.end();
    } catch {}
  };
  child.on("exit", () => errOut("event stream exited"));
  child.on("error", (e) => errOut(String(e?.message || e)));
}

const EXT_BY_MIME = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "video/mp4": "mp4", "audio/mpeg": "mp3" };
const MIME_BY_EXT = Object.fromEntries(Object.entries(EXT_BY_MIME).map(([k, v]) => [v, k]));

// GET /api/resource?conv=&msg=&res=[&type=fileId&name=] -> proxy OSS temp link (1h expiry) to local cache
async function handleResource(u, res) {
  const rawConv = checkId(u.searchParams.get("conv") || "", "conv");
  const conv = convOpenId(u.searchParams.get("kind") === "direct" ? "direct" : "group", rawConv);
  const msg = checkId(u.searchParams.get("msg") || "", "msg");
  const rid = checkId(u.searchParams.get("res") || "", "res");
  const isFile = (u.searchParams.get("type") || "") === "fileId";
  mkdirSync(RES_DIR, { recursive: true });
  if (isFile) {
    // 钉盘文件：dws 直落盘（fileId 不需要消息上下文），原名下载
    const safeName = checkFileName(u.searchParams.get("name") || "file");
    const key = createHash("sha1").update(`file|${rid}`).digest("hex");
    const rawExt = "." + safeName.split(".").pop().toLowerCase();
    const useExt = ["png", "jpg", "jpeg", "gif", "webp", "pdf", "json", "txt", "zip"].includes(rawExt.slice(1)) ? rawExt : ".bin";
    const dest = join(RES_DIR, `${key}${useExt}`);
    if (!existsSync(dest)) {
      runDws("chat", "+messages-resource-download", ["--type", "fileId", "--resource-id", rid, "--output", `${key}${useExt}`], { cwd: RES_DIR, timeout: 120_000 });
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "private, max-age=31536000",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    });
    return res.end(readFileSync(dest));
  }
  const key = createHash("sha1").update(`${conv}|${msg}|${rid}`).digest("hex");
  const hit = ["png", "jpg", "gif", "webp", "bmp", "mp4", "mp3"].map((e) => join(RES_DIR, `${key}.${e}`)).find((f) => existsSync(f));
  if (hit) {
    const ext = hit.split(".").pop();
    res.writeHead(200, { "Content-Type": MIME_BY_EXT[ext] || "application/octet-stream", "Cache-Control": "private, max-age=31536000" });
    return res.end(readFileSync(hit));
  }
  const r = runDws("chat", "+messages-resource-url", ["--type", "mediaId", "--resource-id", rid, "--message-id", msg, "--open-conversation-id", conv]);
  const url = r?.result?.downloadUrl;
  if (!url || !/^https?:\/\//.test(url)) throw new Error("no downloadUrl");
  const up = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!up.ok) throw new Error(`upstream ${up.status}`);
  if (Number(up.headers.get("content-length") || 0) > 25 * 1024 * 1024) throw new Error("file too large");
  const buf = Buffer.from(await up.arrayBuffer());
  const mime = (up.headers.get("content-type") || "").split(";")[0].trim() || "image/png";
  const ext = EXT_BY_MIME[mime] || "png";
  writeFileSync(join(RES_DIR, `${key}.${ext}`), buf);
  res.writeHead(200, { "Content-Type": mime, "Cache-Control": "private, max-age=31536000" });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${HOST}:${PORT}`);
    if (req.method === "GET" && u.pathname === "/api/health") {
      const v = runDwsRaw("version", "", []);
      return send(res, 200, { ok: true, dws: v });
    }
    if (req.method === "GET" && u.pathname === "/api/me") {
      return send(res, 200, { ok: true, me: getMe() });
    }
    if (req.method === "GET" && u.pathname === "/api/conversations") {
      const r = runDws("chat", "+conversation-list", ["--page-all"]);
      const list = unwrapList(r);
      cache.conversations = list;
      saveCacheSoon();
      return send(res, 200, { ok: true, items: list });
    }
    // 侧栏聚合口：会话 + 未读数(notificationOff/unreadPoint) + @数，一次给前端渲染
    // 全量返回（dws 的 --cursor 分页无效，只能 --page-all 全拉；100 个约 1 个接口）
    if (req.method === "GET" && u.pathname === "/api/sidebar") {
      if (!cache.convListTs || Date.now() - cache.convListTs > 60_000) {
        const all = unwrapList(runDws("chat", "+conversation-list", ["--page-all"]));
        cache.conversations = all;
      let unRaw = {};
      try {
        unRaw = runDws("chat", "message list-unread-conversations", ["--count", "200"]);
      } catch {}
      const unItems = unRaw?.result?.conversations || unRaw?.conversations || [];
      const unById = {};
      for (const c of unItems) {
        const id = c.openConversationId || c.conversationId;
        if (id) unById[id] = { n: c.unreadPoint || 0, muted: c.notificationOff === 1, single: !!c.singleChat, last: c.lastMsgCreateAt || 0 };
      }
      // 免打扰只认未读口径的 notificationOff（exclude-muted 差集两批分页对不上，误伤正常群，已弃用）
      const mutedSet = new Set(Object.entries(unById).filter(([, v]) => v.muted).map(([k]) => k));
      let men = [];
      try {
        men = unwrapList(runDws("chat", "+at-me", ["--days", "7", "--limit", "100"]));
      } catch {}
      const readAt = {};
      const atById = {};
      for (const it of men) {
        const cid = it?.conversationId || it?.conversation?.openConversationId;
        if (!cid) continue;
        const e = (atById[cid] ||= { n: 0, senders: [] });
        e.n++;
        if (it.sender && !e.senders.includes(it.sender)) e.senders.push(it.sender);
      }
      const items = cache.conversations.map((c) => {
        const id = c.openConversationId || c.conversationId || c.openDingTalkId || c.userId || "";
        const uu = unById[id] || {};
        const at = atById[id] || { n: 0, senders: [] };
        // @数只看未读里的：会话未读清零则@一起清（dws 的@列表本身无已读位）
        const showAt = (uu.n || 0) > 0 ? at : { n: 0, senders: [] };
        const cached = cache.lastByConv[id];
        const last = Math.max(uu.last || 0, cached?.at || 0);
        return {
          id,
          openId: c.openConversationId || c.conversationId || "",
          name: c.conversationName || c.name || c.title || c.groupName || id,
          single: uu.single ?? !(c.openConversationId || c.conversationId),
          muted: mutedSet.has(id),
          unread: uu.n || 0,
          at: showAt.n,
          atSenders: showAt.senders,
          lastMsgAt: last,
          lastMsgText: cached?.text || "",
        };
      });
      // 后台补齐：只给群会话拉最新 1 条做预览（单聊 id 可能是 userId，
      // 传给 --open-dingtalk-id 会报 target_type_mismatch，故跳过；单聊点开即记时间）
      // 排序：保持 dws 接口原序，不做时间排序
      try {
        const stale = items.filter((c) => !c.single && c.openId && (!cache.lastByConv[c.id] || Date.now() - cache.lastByConv[c.id].ts > 600_000));
        for (const c of stale.slice(0, 4)) {
          try {
            const r = runDws("chat", "+messages-list", ["--group", c.openId, "--time", fmtTime(new Date()), "--forward=false", "--limit", "1"]);
            const m = unwrapList(r)[0];
            if (m?.createTime) {
              const at = new Date(String(m.createTime).replace(" ", "T")).getTime() || 0;
              cache.lastByConv[c.id] = { at, text: previewText(m), ts: Date.now() };
              putMessages(`group:${c.openId}`, [m]);
              if (at > (c.lastMsgAt || 0)) { c.lastMsgAt = at; c.lastMsgText = previewText(m); }
            }
          } catch {}
        }
      } catch {}
      // 排序：dws 接口原序，不做任何排序
      cache.convList = items;
      cache.convListTs = Date.now();
      saveCacheSoon();
      } // end rebuild
      const allItems = cache.convList || [];
      return send(res, 200, { ok: true, items: allItems, total: allItems.length });
    }
    if (req.method === "GET" && u.pathname === "/api/members") {
      const conv = checkId(u.searchParams.get("conv") || "", "conv");
      if (!cache.members[conv]) {
        const r = runDws("chat", "+chat-members-list", ["--group", conv]);
        const users = r?.users || [];
        const meName = getMe()?.name || "";
        const byId = {};
        for (const m of users) {
          const nm = m.nick || m.name || "";
          if (m.openDingtalkId) byId[m.openDingtalkId] = { name: nm, role: m.role || "" };
          if (m.userId) byId[m.userId] = { name: nm, role: m.role || "" };
        }
        let meId = "";
        for (const [id, v] of Object.entries(byId)) if (v.name && v.name === meName) meId = id;
        cache.members[conv] = { byId, names: [...new Set(Object.values(byId).map((v) => v.name).filter(Boolean))], meId, meName };
        saveCacheSoon();
      }
      return send(res, 200, { ok: true, ...cache.members[conv] });
    }
    if (req.method === "GET" && u.pathname === "/api/messages") {
      const kind = u.searchParams.get("kind") === "direct" ? "direct" : "group";
      const id = checkId(u.searchParams.get("id") || "");
      const dir = u.searchParams.get("dir") === "newer" ? "newer" : "older";
      const hasTime = !!u.searchParams.get("time");
      const time = u.searchParams.get("time") || fmtTime(new Date());
      const limit = Math.min(Number(u.searchParams.get("limit") || 30), 100);
      // 无 time = 初次打开：拿最新 N 条；有 time + older = 向上翻旧消息
      const forward = hasTime && dir === "newer" ? "true" : "false";
      const useGroup = isCid(id) || kind !== "direct";
      const r = useGroup
        ? runDws("chat", "+messages-list", ["--group", kind === "direct" ? convOpenId(kind, id) : id, "--time", time, "--forward=" + forward, "--limit", String(limit)])
        : runDws("chat", "+messages-list-direct", ["--open-dingtalk-id", id, "--time", time, "--forward=" + forward, "--limit", String(limit)]);
      const list = unwrapList(r).sort(byTimeAsc);
      putMessages(`${kind}:${id}`, list);
      // 顺手记下该会话最新一条，给侧栏排序/预览用
      try {
        const last = list[list.length - 1];
        if (last?.createTime) {
          const at = new Date(String(last.createTime).replace(" ", "T")).getTime() || 0;
          const prev = cache.lastByConv[id]?.at || 0;
          if (at >= prev) cache.lastByConv[id] = { at, text: previewText(last), ts: Date.now() };
        }
      } catch {}
      return send(res, 200, { ok: true, items: list, hasMore: !!r?.hasMore });
    }
    if (req.method === "GET" && u.pathname === "/api/resource") {
      return await handleResource(u, res);
    }
    // 我的表情包：emotion list + 逐个经 resource-url 落代理（preview 永久有效）
    if (req.method === "GET" && u.pathname === "/api/emotions") {
      const conv = convOpenId(u.searchParams.get("kind") === "direct" ? "direct" : "group", checkId(u.searchParams.get("conv") || "", "conv"));
      const list = runDws("chat", "emotion list", []);
      const emos = list?.result?.emotions || list?.emotions || [];
      // preview 需要一条真实消息做上下文：取该会话缓存里最新一条
      const cacheKey = `group:${u.searchParams.get("conv") || ""}`;
      const cached = cache.messages[cacheKey] || [];
      const ctxMsg = cached.length ? msgKey(cached[cached.length - 1]) : "";
      mkdirSync(RES_DIR, { recursive: true });
      const out = [];
      let resolved = 0;
      for (const e of emos.slice(0, 60)) {
        const mid = e.mediaId || e.media_id || "";
        if (!mid) continue;
        const key = "emo-" + createHash("sha1").update(mid).digest("hex");
        let file = ["gif", "png", "jpg", "webp"].map((x) => join(RES_DIR, `${key}.${x}`)).find((f) => existsSync(f));
        // 首屏只现场解前 24 个 preview，其余照样可点发送（打开越来越快：落盘后全秒出）
        if (!file && ctxMsg && resolved < 24) {
          try {
            const r = runDws("chat", "+messages-resource-url", ["--type", "mediaId", "--resource-id", mid, "--message-id", ctxMsg, "--open-conversation-id", conv]);
            const url = r?.result?.downloadUrl;
            if (url && /^https?:\/\//.test(url)) {
              const up = await fetch(url, { signal: AbortSignal.timeout(20_000) });
              if (up.ok) {
                const mime = (up.headers.get("content-type") || "").split(";")[0].trim();
                const ext = EXT_BY_MIME[mime] || "gif";
                file = join(RES_DIR, `${key}.${ext}`);
                writeFileSync(file, Buffer.from(await up.arrayBuffer()));
                resolved++;
              }
            }
          } catch {}
        }
        out.push({ emotionId: e.emotionId, mediaId: mid, url: file ? `/api/emofile?k=${key}.${file.split(".").pop()}` : "" });
      }
      return send(res, 200, { ok: true, items: out });
    }
    if (req.method === "GET" && u.pathname === "/api/emofile") {
      const k = u.searchParams.get("k") || "";
      if (!/^emo-[0-9a-f]{40}\.(gif|png|jpg|webp)$/.test(k)) {
        res.writeHead(404);
        return res.end();
      }
      const f = join(RES_DIR, k);
      if (!existsSync(f)) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { "Content-Type": MIME_BY_EXT[k.split(".").pop()] || "image/gif", "Cache-Control": "private, max-age=31536000" });
      return res.end(readFileSync(f));
    }
    if (req.method === "POST" && u.pathname === "/api/emotion-send") {
      const b = await readBody(req);
      const kind = b.kind === "direct" ? "direct" : "group";
      const mid = checkId(b.mediaId || "", "mediaId");
      const target = kind === "direct" ? ["--open-dingtalk-id", checkId(b.id)] : ["--group", checkId(b.id)];
      const r = runDws("chat", "emotion send", ["--media-id", mid, ...target]);
      return send(res, 200, { ok: true, result: r });
    }
    if (req.method === "GET" && u.pathname === "/api/unread") {
      const r = runDws("chat", "+messages-list-unread-conversations", []);
      return send(res, 200, { ok: true, items: unwrapList(r) });
    }
    if (req.method === "GET" && u.pathname === "/api/at-me") {
      const r = runDws("chat", "+at-me", []);
      return send(res, 200, { ok: true, items: unwrapList(r) });
    }
    if (req.method === "POST" && u.pathname === "/api/send") {
      const b = await readBody(req);
      const kind = b.kind === "direct" ? "direct" : "group";
      const text = checkText(b.text);
      const atIds = Array.isArray(b.atIds) ? [...new Set(b.atIds)].map((v) => checkId(v, "atId")) : [];
      const target = kind === "direct" && !isCid(b.id) ? ["--open-dingtalk-id", checkId(b.id)] : ["--chat-id", checkId(kind === "direct" ? convOpenId(kind, b.id) : b.id)];
      const extra = atIds.length && kind === "group" ? ["--at-open-dingtalk-ids", atIds.join(",")] : [];
      const r = runDws("chat", "+messages-send", ["--as", "user", ...target, "--text", text, "--ai-tag=false", ...extra]);
      return send(res, 200, { ok: true, result: r });
    }
    if (req.method === "POST" && u.pathname === "/api/mark-read") {
      const b = await readBody(req);
      const id = convOpenId(b.kind === "direct" ? "direct" : "group", checkId(b.id));
      const r = runDws("chat", "+conversation-mark-read", ["--conversation-id", id, "--message-id", checkId(b.msgId || "", "msgId")]);
      return send(res, 200, { ok: true, result: r });
    }
    if (req.method === "POST" && u.pathname === "/api/react") {
      const b = await readBody(req);
      const id = convOpenId(b.kind === "direct" ? "direct" : "group", checkId(b.id));
      const emoji = String(b.emoji || "");
      if (!["赞", "OK", "爱心", "大笑", "鼓掌"].includes(emoji)) throw new Error("unsupported emoji");
      const r = runDws("chat", "+messages-add-emoji", ["--conversation-id", id, "--msg-id", checkId(b.msgId || "", "msgId"), "--emoji", emoji]);
      return send(res, 200, { ok: true, result: r });
    }
    if (req.method === "POST" && u.pathname === "/api/recall") {
      const b = await readBody(req);
      const id = convOpenId(b.kind === "direct" ? "direct" : "group", checkId(b.id));
      const r = runDws("chat", "+messages-recall", ["--conversation-id", id, "--msg-id", checkId(b.msgId || "", "msgId")]);
      return send(res, 200, { ok: true, result: r });
    }
    if (req.method === "POST" && u.pathname === "/api/reply") {
      const b = await readBody(req);
      const id = convOpenId(b.kind === "direct" ? "direct" : "group", checkId(b.id));
      const args = ["--group", id, "--ref-msg-id", checkId(b.refMsgId || "", "refMsgId"), "--ref-sender", checkId(b.refSender || "", "refSender"), "--content", checkText(b.text), "--ai-tag=false"];
      const atIds = Array.isArray(b.atIds) ? [...new Set(b.atIds)].map((v) => checkId(v, "atId")) : [];
      if (atIds.length) args.push("--at-open-dingtalk-ids", atIds.join(","));
      const r = runDws("chat", "message reply", args);
      return send(res, 200, { ok: true, result: r });
    }
    // 发文件/图片：base64 → 落 staging → +messages-send --file（dws 无本地→mediaId 上传，图片也以文件附件发出）
    if (req.method === "POST" && (u.pathname === "/api/send-file" || u.pathname === "/api/send-image")) {
      const b = await readBody(req);
      const kind = b.kind === "direct" ? "direct" : "group";
      const safeName = checkFileName(b.name || "file");
      const ext = safeName.split(".").pop().toLowerCase();
      if (!["png", "jpg", "jpeg", "gif", "webp", "bmp", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "zip", "rar", "7z", "mp3", "wav", "mp4", "mov"].includes(ext)) throw new Error("unsupported file type in v1");
      const raw = Buffer.from(b.data || "", "base64");
      if (!raw.length || raw.length > 20 * 1024 * 1024) throw new Error("invalid data (empty or >20MB)");
      const upDir = join(DATA_DIR, "up");
      mkdirSync(upDir, { recursive: true });
      // 落盘就用原名（对端看到的就是这个名），重名加序号
      let tmp = safeName, n = 1;
      while (existsSync(join(upDir, tmp))) {
        const dot = safeName.lastIndexOf(".");
        tmp = `${safeName.slice(0, dot)}(${n++})${safeName.slice(dot)}`;
      }
      writeFileSync(join(upDir, tmp), raw);
      try {
        const target = kind === "direct" && !isCid(b.id) ? ["--open-dingtalk-id", checkId(b.id)] : ["--chat-id", checkId(kind === "direct" ? convOpenId(kind, b.id) : b.id)];
        const r = runDws("chat", "+messages-send", ["--as", "user", ...target, "--msg-type", "file", "--file", tmp, "--ai-tag=false"], { cwd: upDir, timeout: 120_000 });
        return send(res, 200, { ok: true, result: r });
      } finally {
        try {
          await import("node:fs").then((fs) => fs.unlinkSync(join(upDir, tmp)));
        } catch {}
      }
    }
    if (req.method === "GET" && u.pathname === "/api/events") return handleEvents(res);
    if (req.method === "GET") {
      if (serveStatic(req, res)) return;
      return send(res, 404, { ok: false, message: "not found" });
    }
    return send(res, 404, { ok: false, message: "not found" });
  } catch (e) {
    if (res.headersSent || res.writableEnded) {
      try {
        res.end();
      } catch {}
      return;
    }
    return send(res, 500, { ok: false, message: String(e?.message || e) });
  }
});

process.on("uncaughtException", (e) => console.error("[uncaught]", e?.message || e));
server.on("clientError", (err, socket) => {
  try {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  } catch {}
});
server.on("error", (e) => {
  if (e?.code === "EADDRINUSE") {
    console.error(`port ${PORT} in use: another server already running?`);
    process.exit(1);
  }
  throw e;
});
server.listen(PORT, HOST, () => console.log(`dingtalk-im-api on http://${HOST}:${PORT}`));
