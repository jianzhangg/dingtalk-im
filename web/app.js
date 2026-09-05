// 本地钉钉 IM v2：上旧下新置底沉底、头像/@/图片/引用/表情、仿钉样式。
const $ = (s) => document.querySelector(s);
const state = { conv: null, kind: "group", convId: "", members: { byId: {}, names: [], meId: "", meName: "" }, oldest: "", latest: "", latestMid: "", loadingOlder: false, hasMore: true, es: null, pendNew: 0, pending: [] };

const AVC = ["#0089ff", "#00b42a", "#ff7d00", "#f53f3f", "#722ed1", "#13c2c2", "#eb0aa4", "#86909c"];
const avColor = (n) => AVC[[...String(n || "?")].reduce((a, c) => a + c.codePointAt(0), 0) % AVC.length];

async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json();
  if (!j.ok) throw new Error(j.message || "api error");
  return j;
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const idOf = (c) => c?.openConversationId || c?.conversationId || c?.openDingTalkId || c?.userId || "";
const nameOf = (c) => c?.conversationName || c?.name || c?.title || c?.groupName || idOf(c);
const msgIdOf = (m) => String(m?.messageId || m?.msgId || m?.id || "");
const senderIdOf = (m) => String(m?.senderId || m?.senderUserId || m?.openDingTalkId || "");
function dispName(m) {
  const sid = senderIdOf(m);
  if (state.members.byId[sid]?.name) return state.members.byId[sid].name;
  return m?.senderName || m?.sender || "未知";
}
function isMine(m) {
  const sid = senderIdOf(m);
  if (state.members.meId && sid === state.members.meId) return true;
  const nm = dispName(m);
  return !!state.members.meName && nm === state.members.meName;
}
// 时间分割线文案
function dayLabel(ts) {
  const d = new Date(String(ts).replace(" ", "T"));
  if (isNaN(d)) return String(ts);
  const now = new Date(), p = (n) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const ymd = (x) => x.toDateString();
  if (ymd(d) === ymd(now)) return hm;
  const y = new Date(now - 864e5);
  if (ymd(d) === ymd(y)) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}
// 富文本管线：转义 → 图片(mediaId) → 链接 → @高亮
function rich(text, m, convOverride) {
  const conv = convOverride || state.convId;
  let h = esc(text);
  h = h.replace(/\[文件\]\s*(\S+)\s*fileId:\s*([A-Za-z0-9+/=_@$.-]+)(?:\s*url:\s*url)?/g, (_, nm, fid) => {
    const href = `/api/resource?kind=${state.kind}&conv=${encodeURIComponent(conv)}&msg=${encodeURIComponent(msgIdOf(m))}&res=${encodeURIComponent(fid)}&type=fileId&name=${encodeURIComponent(nm)}`;
    return `<div class="filecard"><span>📄</span><span class="fn">${esc(nm)}</span><a href="${href}">下载</a></div>`;
  });
  h = h.replace(/\[([^\]]*)\]\(mediaId=([@$][^)]+)\)/g, (_, alt, rid) => {
    const src = `/api/resource?kind=${state.kind}&conv=${encodeURIComponent(conv)}&msg=${encodeURIComponent(msgIdOf(m))}&res=${encodeURIComponent(rid)}`;
    return `<img loading="lazy" src="${src}" alt="${esc(alt || "图片")}" onclick="openLightbox(this.src)" onerror="this.outerHTML='[图片加载失败]'">`;
  });
  h = h.replace(/(https?:\/\/[^\s<>()"]+)/g, '<a href="$1" target="_blank">$1</a>');
  const names = [...state.members.names].sort((a, b) => b.length - a.length);
  for (const n of names) {
    if (!n || !h.includes("@" + esc(n))) continue;
    h = h.split("@" + esc(n)).join(`<span class="at">@${esc(n)}</span>`);
  }
  if (state.members.meName && h.includes("@" + esc(state.members.meName))) { /* 已在上面处理 */ }
  return h;
}
function avatarHtml(name, uid) {
  const t = String(name || "?").trim().slice(0, 1) || "?";
  const data = uid ? ` data-uid="${esc(uid)}" data-nm="${esc(name)}" title="点击 @TA"` : "";
  return `<div class="avatar sm" style="background-color:${avColor(name)}"${data}>${esc(t)}</div>`;
}
function msgNode(m) {
  const me = isMine(m), nm = dispName(m);
  const row = document.createElement("div");
  row.className = "row" + (me ? " me" : "");
  row.dataset.mid = msgIdOf(m);
  if (String(msgIdOf(m)).startsWith("tmp")) row.dataset.ts = Date.now();
  const sid = senderIdOf(m);
  let inner = avatarHtml(nm, sid);
  let body = `<div class="body"><div class="who">${me ? "" : `<span class="nm" data-uid="${esc(sid)}" data-nm="${esc(nm)}" title="点击 @TA">${esc(nm)}</span> · `}${esc(m?.createTime || "")}</div><div class="bubble">${rich(m?.text || "", m)}`;
  if (m?.quotedMessage) {
    const q = m.quotedMessage;
    body += `<div class="quote">${esc(q.sender || "")}: ${rich(q.text || "", { messageId: q.messageId || msgIdOf(m) }, q.conversationId).slice(0, 400)}</div>`;
  }
  const rc = m?.reactions?.counts;
  if (Array.isArray(rc) && rc.length) {
    const det = {};
    for (const d of m?.reactions?.details || []) det[d.emoji] = d.replyUsers || [];
    const meNm = state.members.meName;
    body += `<div class="reacts">${rc.map((r) => {
      const users = det[r.emoji] || [];
      const total = r.count || users.length;
      const show = users.slice(0, 3).join(" ");
      const more = total > users.length ? `等${total - users.length}人` : "";
      const on = meNm && users.includes(meNm) ? " on" : "";
      return `<span class="react${on}" title="${esc(r.emoji)} ${esc(users.join("、"))}">${reactIcon(r.emoji)}${show ? ` ${esc(show)}` : ""}${more}</span>`;
    }).join("")}</div>`;
  }
  const mid = msgIdOf(m);
  if (!String(mid).startsWith("tmp")) {
    body += `<div class="tools"><span data-emobtn="${esc(mid)}" title="表情回应"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><circle cx="9" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1" fill="currentColor" stroke="none"/><path d="M8.5 14.5c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8"/></svg></span><span data-reply="${esc(mid)}" data-rsender="${esc(sid)}" data-rname="${esc(nm)}" data-rtext="${esc((m?.text || "").slice(0, 80))}" title="引用回复">回复</span>${me ? `<span data-recall="${esc(mid)}" title="撤回">撤回</span>` : ""}</div>`;
  }
  body += `</div></div>`;
  row.innerHTML = inner + body;
  return row;
}
// 点头像/名字 @TA（仅群聊）；撤回自己刚发的消息
window.atUser = (id, name) => {
  if (state.kind !== "group" || !id || !name || id === state.members.meId || name === state.members.meName) return;
  const el = $("#input"), pos = el.selectionStart ?? el.value.length;
  el.value = el.value.slice(0, pos) + `@${name} ` + el.value.slice(pos);
  if (!state.atPicked.some((x) => x.id === id)) state.atPicked.push({ id, name });
  el.focus();
};
$("#msgs").addEventListener("click", async (e) => {
  const u = e.target.closest("[data-uid]");
  if (u && u.dataset.uid) { atUser(u.dataset.uid, u.dataset.nm); return; }
  const r = e.target.closest("[data-recall]");
  if (r && r.dataset.recall) {
    if (!confirm("撤回这条消息？")) return;
    try {
      await api("/api/recall", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: state.kind, id: state.convId, msgId: r.dataset.recall }) });
      r.closest(".row")?.remove();
    } catch (err) {
      alert("撤回失败：" + err.message);
    }
    return;
  }
  const q = e.target.closest("[data-reply]");
  if (q && q.dataset.reply) {
    startReply({ mid: q.dataset.reply, senderId: q.dataset.rsender || "", name: q.dataset.rname || "", snippet: q.dataset.rtext || "" });
    return;
  }
  const eb = e.target.closest("[data-emobtn]");
  if (eb && eb.dataset.emobtn) {
    openReactPick(eb.dataset.emobtn, eb);
  }
});
// 表情回应：悬浮条😊点开5个钉钉表情，点即贴到该消息
const REACTS = [["👍", "赞"], ["👌", "OK"], ["❤️", "爱心"], ["😂", "大笑"], ["👏", "鼓掌"]];
const REACT_ICON = Object.fromEntries([...REACTS.map(([u, n]) => [n, u]), ["已合并", "✅"]]);
const reactIcon = (n) => REACT_ICON[n] || n;
function openReactPick(mid, anchor) {
  closeReactPick();
  const d = document.createElement("div");
  d.id = "reactpick";
  d.innerHTML = REACTS.map(([u, n]) => `<span data-n="${n}" title="${n}">${u}</span>`).join("");
  const r = anchor.getBoundingClientRect();
  d.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 230)) + "px";
  d.style.top = (r.bottom + 6) + "px";
  document.body.appendChild(d);
  d.querySelectorAll("span").forEach((s) => (s.onclick = async (ev) => {
    ev.stopPropagation();
    closeReactPick();
    try {
      await api("/api/react", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: state.kind, id: state.convId, msgId: mid, emoji: s.dataset.n }) });
      setTimeout(pollNewer, 1500);
    } catch (err) {
      alert("表情回应失败：" + err.message);
    }
  }));
  setTimeout(() => document.addEventListener("click", closeReactPick, { once: true }), 0);
}
function closeReactPick() { $("#reactpick")?.remove(); }
// 引用回复：输入框上沿挂引用条，发送走 /api/reply
function startReply(t) {
  state.replyTo = t;
  const bar = $("#quotebar");
  bar.style.display = "flex";
  bar.querySelector(".qt").textContent = `回复 ${t.name}: ${t.snippet}`;
  // 默认@原作者：直接写进输入框看得见，删掉即取消
  if (state.kind === "group" && t.senderId && t.name && t.name !== state.members.meName) {
    const el = $("#input");
    if (!el.value.includes("@" + t.name)) {
      el.value = `@${t.name} ` + el.value;
      if (!state.atPicked.some((x) => x.id === t.senderId)) state.atPicked.push({ id: t.senderId, name: t.name });
    }
  }
  $("#input").focus();
}
function cancelReply() {
  state.replyTo = null;
  $("#quotebar").style.display = "none";
}
const nearBottom = () => { const w = $("#wrap"); return w.scrollHeight - w.scrollTop - w.clientHeight < 140; };
const toBottom = () => { const w = $("#wrap"); w.scrollTop = w.scrollHeight; };
// 贴底：图片是异步撑开高度的，单次 toBottom 会漂移；进会话后连钉三次（只要用户没主动往上滑）
function pinBottom() {
  toBottom();
  requestAnimationFrame(() => { if (nearBottom()) toBottom(); });
  setTimeout(() => { if (nearBottom()) toBottom(); }, 400);
}
// 图片加载完撑开高度时，如果用户本来就在底部就跟下去
$("#msgs").addEventListener("load", () => { if (nearBottom()) toBottom(); }, true);
window.openLightbox = (src) => { $("#lightbox-img").src = src; $("#lightbox").style.display = "flex"; };
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#lightbox").style.display = "none"; });
// 点进会话即标已读：清掉本会话的红点/@提醒
async function markRead() {
  if (!state.convId || !state.latestMid) return;
  try {
    await api("/api/mark-read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: state.kind, id: state.convId, msgId: state.latestMid, time: state.latest }) });
  } catch (e) {
    console.warn("markRead", e.message);
    return;
  }
  // 本地即时清徽标（服务端已同步，下次拉 sidebar 对得上）
  const li = [...document.querySelectorAll("#convs li")].find((x) => x.title === state.convId);
  if (li) {
    li.querySelector(".badge")?.remove();
    const t = li.querySelector(".t");
    if (t) t.textContent = t.textContent.replace(/\s*\[\d+条@我\]/, "");
    const s = li.querySelector(".s");
    if (s && /未读|@了我/.test(s.textContent)) s.textContent = "";
  }
}

function convRow(c) {
  const li = document.createElement("li");
  const atTxt = c.at ? ` <span class="atme">[${c.at}条@我]</span>` : "";
  const sub = c.at ? `${esc((c.atSenders || []).join("、"))} @了我` : c.unread ? `${c.unread} 条未读` : esc((c.lastMsgText || "").slice(0, 24));
  const tm = c.lastMsgAt ? fmtListTime(c.lastMsgAt) : "";
  const right = c.unread
    ? `<div class="badge">${c.unread > 99 ? "99+" : c.unread}</div>`
    : `${c.pinned ? `<span class="pin" title="已置顶">📌</span>` : ""}${c.muted ? `<span class="bell" title="免打扰">🔕</span>` : ""}`;
  li.innerHTML = `<div class="avatar" style="background-color:${avColor(c.name)}">${esc(c.name.slice(0, 1))}</div>
    <div class="nm"><div class="t"><span class="n">${esc(c.name)}${atTxt}</span>${tm ? `<span class="lt">${tm}</span>` : ""}</div>
    <div class="s"><span class="sub">${sub}</span>${right}</div></div>
    <span class="pinbtn" data-pin="${esc(c.id)}" data-on="${c.pinned ? 1 : 0}" title="${c.pinned ? "取消置顶" : "置顶"}">📌</span>`;
  li.title = c.id;
  li.onclick = () => select(c, li);
  li.querySelector(".pinbtn").onclick = async (ev) => {
    ev.stopPropagation();
    await api("/api/pin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: c.id, pin: !c.pinned }) });
    loadConvs();
  };
  if (state.convId === c.id) li.classList.add("active");
  return li;
}
function fmtListTime(ts) {
  const d = new Date(ts), now = new Date();
  const hh = String(d.getHours()).padStart(2, "0"), mm = String(d.getMinutes()).padStart(2, "0");
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `${hh}:${mm}`;
  const yest = new Date(now - 864e5).toDateString() === d.toDateString();
  if (yest) return `昨天 ${hh}:${mm}`;
  return `${d.getMonth() + 1}-${d.getDate()}`;
}
async function loadConvs() {
  $("#status").textContent = "拉取会话…";
  const { items } = await api("/api/sidebar");
  const ul = $("#convs");
  ul.innerHTML = "";
  for (const c of items) ul.appendChild(convRow(c));
  $("#status").textContent = `会话 ${items.length} 个 · SSE 已连`;
}
async function select(c, li) {
  document.querySelectorAll("#convs li").forEach((x) => x.classList.remove("active"));
  li.classList.add("active");
  state.conv = c;
  state.convId = c.id;
  state.kind = c.single ? "direct" : "group";
  state.oldest = ""; state.latest = ""; state.hasMore = true; state.pendNew = 0;
  state.pending = [];
  state.atPicked = []; closeAt(); cancelReply();
  $("#pill").style.display = "none";
  $("#title").textContent = c.name;
  const box = $("#msgs");
  box.innerHTML = `<div class="day">加载中…</div>`;
  try {
    const mem = state.kind === "group" ? await api(`/api/members?conv=${encodeURIComponent(state.convId)}`) : { byId: {}, names: [], meId: "", meName: state.members.meName };
    if (!mem.meName) { try { mem.meName = (await api("/api/me")).me?.name || ""; } catch {} }
    state.members = { byId: mem.byId || {}, names: mem.names || [], meId: mem.meId || "", meName: mem.meName || "" };
    $("#subtitle").textContent = state.kind === "group" ? `${(await memberCount())} 人` : "";
    const { items, hasMore } = await api(`/api/messages?kind=${state.kind}&id=${encodeURIComponent(state.convId)}&limit=30`);
    state.hasMore = !!hasMore;
    box.innerHTML = items.length ? "" : `<div class="day">暂无消息</div>`;
    let lastDay = "";
    for (const m of items) {
      const dl = dayLabel(m.createTime).split(" ")[0];
      if (dl !== lastDay) { lastDay = dl; box.insertAdjacentHTML("beforeend", `<div class="day">${esc(dayLabel(m.createTime))}</div>`); }
      box.appendChild(msgNode(m));
      if (!state.oldest || m.createTime < state.oldest) state.oldest = m.createTime;
      if (!state.latest || m.createTime > state.latest) { state.latest = m.createTime; state.latestMid = msgIdOf(m); }
    }
    pinBottom();
    markRead();
  } catch (e) {
    box.innerHTML = `<div class="day">拉取失败：${esc(e.message)}</div>`;
  }
}
async function memberCount() {
  return Object.keys(state.members.byId).length || "";
}
state.lastOlderAt = 0;
state.lastRestoreAt = 0;
async function loadOlder() {
  const now = Date.now();
  // 只响应"顶到头"的用户手势： cooldown + 程序化回弹 1s 内不触发，根治上下跳动
  if (state.loadingOlder || !state.hasMore || !state.convId || !state.oldest) return;
  if ($("#wrap").scrollTop > 2 || now - state.lastOlderAt < 1500 || now - state.lastRestoreAt < 1000) return;
  state.loadingOlder = true;
  state.lastOlderAt = now;
  const w = $("#wrap"), before = w.scrollHeight;
  try {
    const { items, hasMore } = await api(`/api/messages?kind=${state.kind}&id=${encodeURIComponent(state.convId)}&limit=30&dir=older&time=${encodeURIComponent(state.oldest)}`);
    state.hasMore = !!hasMore;
    const box = $("#msgs"), frag = document.createDocumentFragment();
    for (const m of items) {
      if (m.createTime < state.oldest) state.oldest = m.createTime;
      frag.appendChild(msgNode(m));
    }
    box.prepend(frag);
    w.scrollTop = w.scrollHeight - before;
    state.lastRestoreAt = Date.now();
  } catch (e) {
    console.warn("loadOlder", e.message);
  } finally {
    state.loadingOlder = false;
  }
}
async function pollNewer() {
  if (!state.convId || !state.latest) return;
  try {
    const { items } = await api(`/api/messages?kind=${state.kind}&id=${encodeURIComponent(state.convId)}&limit=20&dir=newer&time=${encodeURIComponent(state.latest)}`);
    const box = $("#msgs"), have = new Set([...box.querySelectorAll(".row")].map((r) => r.dataset.mid));
    let added = 0;
    for (const m of items) {
      if (have.has(msgIdOf(m))) continue;
      box.appendChild(msgNode(m));
      if (m.createTime > state.latest) { state.latest = m.createTime; state.latestMid = msgIdOf(m); }
      added++;
    }
    if (added) {
      if (nearBottom()) { toBottom(); markRead(); }
      else {
        state.pendNew += added;
        const p = $("#pill");
        p.textContent = `${state.pendNew} 条新消息 ↓`;
        p.style.display = "block";
      }
    }
    // 发出去的 optimistic 临时节点一旦在服务端出现就撤掉，避免"我发的"显示两遍
    const now = Date.now();
    state.pending = state.pending.filter((p) => now - p.ts < 120000);
    document.querySelectorAll('#msgs .row').forEach((r) => {
      const mm = r.dataset.mid || "";
      if (!mm.startsWith("tmp")) return;
      const bt = (r.querySelector(".bubble")?.innerText || "").trim();
      const ageOk = now - (+r.dataset.ts || now) < 120000;
      const i = state.pending.findIndex((p) => bt === p.text || bt.endsWith(p.text));
      if ((i >= 0 && ageOk) || !ageOk) {
        if (i >= 0) state.pending.splice(i, 1);
        r.remove();
      }
    });
  } catch (e) {
    console.warn("pollNewer", e.message);
  }
}
const readAsB64 = (f) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(",")[1]);
  r.onerror = rej;
  r.readAsDataURL(f);
});
async function send() {
  const v = $("#input").value.trim();
  const files = state.pendingFiles.splice(0);
  renderFilePreview();
  if ((!v && !files.length) || !state.convId) return;
  // 把 @名字 换成 dws 要求的 <@openDingTalkId> 占位，并收集 atIds
  let text = v;
  const atIds = [];
  const cand = [...state.atPicked, ...state.members.names.map((n) => ({ name: n, id: Object.keys(state.members.byId).find((k) => state.members.byId[k].name === n) }))].filter((x) => x.id);
  cand.sort((a, b) => b.name.length - a.name.length);
  for (const { name, id } of cand) {
    if (text.includes("@" + name)) {
      text = text.split("@" + name).join(`<@${id}>`);
      atIds.push(id);
    }
  }
  $("#input").value = "";
  state.atPicked = [];
  const rp = state.replyTo;
  cancelReply();
  if (v) state.pending.push({ text: v, ts: Date.now() });
  if (v) {
    const tmp = { messageId: "tmp" + Date.now(), sender: state.members.meName, senderId: state.members.meId, createTime: "刚刚", text: v };
    if (rp) tmp.quotedMessage = { sender: rp.name, text: rp.snippet };
    $("#msgs").appendChild(msgNode({ ...tmp, senderId: state.members.meId }));
    toBottom();
  }
  const btn = $("#send");
  btn.disabled = true;
  btn.textContent = files.length ? "发送中…" : "发送";
  try {
    for (const pf of files) {
      const data = await readAsB64(pf.file);
      await api("/api/send-file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: state.kind, id: state.convId, name: pf.file.name || "file", data }) });
      if (pf.url) URL.revokeObjectURL(pf.url);
    }
    if (v) {
      if (rp) {
        await api("/api/reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: state.kind, id: state.convId, refMsgId: rp.mid, refSender: rp.senderId, text, atIds }) });
      } else {
        await api("/api/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: state.kind, id: state.convId, text, atIds }) });
      }
    }
    setTimeout(pollNewer, 2000);
  } catch (e) {
    alert("发送失败：" + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "发送";
  }
}
// @ 成员选择：输入 @xxx 弹出过滤，Tab/Enter 选中，Esc 关闭（选择只在群聊有效）
state.atPicked = [];
state.atOpen = false;
state.atList = [];
state.atIdx = 0;
function closeAt() { state.atOpen = false; $("#atpick").style.display = "none"; }
function openAt(q) {
  const all = Object.entries(state.members.byId).map(([id, v]) => ({ id, name: v.name })).filter((x) => x.name);
  state.atList = all.filter((x) => !q || x.name.includes(q)).slice(0, 8);
  if (!state.atList.length || state.kind !== "group") return closeAt();
  state.atOpen = true;
  state.atIdx = 0;
  renderAt();
}
function renderAt() {
  const box = $("#atpick");
  box.innerHTML = state.atList.map((x, i) => `<div class="${i === state.atIdx ? "sel" : ""}" data-i="${i}">${avatarHtml(x.name, x.id)}<span>${esc(x.name)}</span></div>`).join("");
  box.style.display = "block";
  box.querySelectorAll("div").forEach((d) => (d.onclick = () => pickAt(Number(d.dataset.i))));
}
function pickAt(i) {
  const t = state.atList[i];
  if (!t) return closeAt();
  const el = $("#input"), pos = el.selectionStart ?? el.value.length;
  const before = el.value.slice(0, pos), after = el.value.slice(pos);
  const m = before.match(/@([^\s@]*)$/);
  const head = m ? before.slice(0, m.index) : before;
  el.value = head + "@" + t.name + " " + after;
  if (!state.atPicked.some((x) => x.id === t.id)) state.atPicked.push(t);
  closeAt();
  el.focus();
}
$("#input").addEventListener("input", () => {
  const el = $("#input"), pos = el.selectionStart ?? el.value.length;
  const m = el.value.slice(0, pos).match(/@([^\s@]*)$/);
  if (m && state.kind === "group" && Object.keys(state.members.byId).length) openAt(m[1]);
  else closeAt();
});
$("#input").addEventListener("blur", () => setTimeout(closeAt, 150));
function connectSSE() {
  state.es?.close();
  const es = new EventSource("/api/events");
  state.es = es;
  es.onmessage = () => pollNewer();
  es.onerror = () => { $("#status").textContent = "事件流断开，靠手动刷新（后端重连中）"; };
}
$("#wrap").addEventListener("scroll", () => {
  if ($("#wrap").scrollTop < 60) loadOlder();
  if (nearBottom() && state.pendNew > 0) {
    state.pendNew = 0;
    $("#pill").style.display = "none";
    markRead();
  }
});
$("#pill").onclick = () => { state.pendNew = 0; $("#pill").style.display = "none"; toBottom(); markRead(); };
$("#send").onclick = send;
const EMOJIS = "😀😁😂🤣😊😍😘😜🤔😅😭😡👍👎🙏👏💪🎉🔥❤️💔✨✅❌❓💯".split(/(?=\p{EPres}|\p{Emoji}\uFE0F?)/u).filter(Boolean);
let emoLoaded = "";
function hidePanels() { $("#emopanel").style.display = "none"; $("#stickerpanel").style.display = "none"; }
document.querySelectorAll(".px").forEach((x) => (x.onclick = () => { document.getElementById(x.dataset.p).style.display = "none"; }));
function openEmoPanel() {
  const p = $("#emopanel");
  $("#stickerpanel").style.display = "none";
  if (p.style.display === "block") return (p.style.display = "none");
  p.style.display = "block";
  $("#emojirow").innerHTML = EMOJIS.map((e) => `<span>${e}</span>`).join("");
  $("#emojirow").querySelectorAll("span").forEach((s) => (s.onclick = () => {
    const el = $("#input"), pos = el.selectionStart ?? el.value.length;
    el.value = el.value.slice(0, pos) + s.textContent + el.value.slice(pos);
    el.focus();
  }));
}
async function openStickerPanel() {
  const p = $("#stickerpanel");
  $("#emopanel").style.display = "none";
  if (p.style.display === "block") return (p.style.display = "none");
  p.style.display = "block";
  if (emoLoaded === state.convId || !state.convId) return;
  const g = $("#emogrid");
  g.innerHTML = `<div class="eno">加载中…</div>`;
  try {
    const { items } = await api(`/api/emotions?conv=${encodeURIComponent(state.convId)}&kind=${state.kind}`);
    emoLoaded = state.convId;
    g.innerHTML = "";
    const sendEmo = async (it) => {
      p.style.display = "none";
      try {
        await api("/api/emotion-send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: state.kind, id: state.convId, mediaId: it.mediaId }) });
        setTimeout(pollNewer, 2000);
      } catch (e) {
        alert("表情发送失败：" + e.message);
      }
    };
    for (const it of items) {
      const cell = document.createElement("div");
      if (it.url) {
        const im = document.createElement("img");
        im.loading = "lazy";
        im.src = it.url;
        im.title = "发送该表情包";
        cell.appendChild(im);
      } else {
        cell.className = "eno";
        cell.title = "无预览，点即发送";
        cell.textContent = "表情" + String(it.emotionId).slice(-4);
      }
      cell.onclick = () => sendEmo(it);
      g.appendChild(cell);
    }
  } catch (e) {
    g.innerHTML = `<div class="eno">加载失败</div>`;
  }
}
// 输入框工具栏：emoji / 表情包 / 图片 / 文件
state.pickMode = "img";
$("#tbtn-emo").onclick = () => state.convId && openEmoPanel();
$("#tbtn-sticker").onclick = () => state.convId && openStickerPanel();
$("#tbtn-img").onclick = () => {
  if (!state.convId) return;
  state.pickMode = "img";
  const fp = $("#filepick");
  fp.accept = "image/png,image/jpeg,image/gif,image/webp,.bmp";
  fp.click();
};
$("#tbtn-file").onclick = () => {
  if (!state.convId) return;
  state.pickMode = "file";
  const fp = $("#filepick");
  fp.accept = "";
  fp.click();
};
// 待发送附件：先预览，点发送才和文本一起发出
state.pendingFiles = [];
function renderFilePreview() {
  const box = $("#filepreview");
  box.innerHTML = "";
  state.pendingFiles.forEach((pf, i) => {
    const d = document.createElement("div");
    d.className = "fpick";
    d.innerHTML = pf.img
      ? `<img src="${pf.url}" onclick="openLightbox(this.src)" title="点击放大"><span class="fx" data-i="${i}">×</span>`
      : `<div class="fname">📄${esc(pf.file.name)}</div><span class="fx" data-i="${i}">×</span>`;
    box.appendChild(d);
  });
  box.style.display = state.pendingFiles.length ? "flex" : "none";
  box.querySelectorAll(".fx").forEach((x) => (x.onclick = () => {
    const gone = state.pendingFiles.splice(Number(x.dataset.i), 1)[0];
    if (gone?.url) URL.revokeObjectURL(gone.url);
    renderFilePreview();
  }));
}
function stageFiles(list) {
  if (!state.convId) return;
  for (const f of list) {
    if (f.size > 20 * 1024 * 1024) { alert(`"${f.name}" 超过 20MB，跳过`); continue; }
    const img = f.type.startsWith("image/");
    if (state.pickMode === "img" && !img) continue;
    state.pendingFiles.push({ file: f, img, url: img ? URL.createObjectURL(f) : "" });
  }
  renderFilePreview();
  $("#input").focus();
}
$("#filepick").onchange = () => {
  stageFiles([...$("#filepick").files]);
  $("#filepick").value = "";
};
// 剪贴板粘贴：只进预览，不直接发
$("#input").addEventListener("paste", (e) => {
  const fs = [...(e.clipboardData?.items || [])].filter((it) => it.type.startsWith("image/")).map((it) => it.getAsFile()).filter(Boolean);
  if (fs.length && state.convId) {
    e.preventDefault();
    stageFiles(fs);
  }
});
$("#input").onkeydown = (e) => {
  if (state.atOpen && ["ArrowDown", "ArrowUp", "Tab", "Enter", "Escape"].includes(e.key)) {
    e.preventDefault();
    if (e.key === "ArrowDown") { state.atIdx = (state.atIdx + 1) % state.atList.length; renderAt(); }
    if (e.key === "ArrowUp") { state.atIdx = (state.atIdx - 1 + state.atList.length) % state.atList.length; renderAt(); }
    if (e.key === "Tab" || e.key === "Enter") pickAt(state.atIdx);
    if (e.key === "Escape") closeAt();
    return;
  }
  // isComposing：中文拼音输入中按回车是选字，不能当发送
  if (e.key === "Enter" && !e.isComposing) send();
};
(async () => {
  try { state.members.meName = (await api("/api/me")).me?.name || ""; } catch {}
  await loadConvs().catch((e) => ($("#status").textContent = "失败：" + e.message));
  connectSSE();
})();
