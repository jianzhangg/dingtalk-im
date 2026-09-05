import test from "node:test";
import assert from "node:assert/strict";

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function tryRenderFeedCard(text) {
  if (!text || !text.includes("BIZ_TYPE_ONEFEED_POST")) return null;

  let targetUrl = "";
  const linkM = text.match(/dingtalk:\/\/dingtalkclient\/page\/link\?url=([^&\s]+)/);
  if (linkM) {
    try { targetUrl = decodeURIComponent(linkM[1]); } catch { targetUrl = linkM[1]; }
  }

  let paragraph = "";
  let images = [];
  let description = "";
  let tag = "圈子";
  const actions = [];

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || typeof item !== "object") continue;
          if (item.type === "PARAGRAPH") {
            const p = item.text?.zh_Hans || (typeof item.text === "string" ? item.text : "");
            if (p) paragraph = p;
          } else if (item.type === "IMAGE" && Array.isArray(item.images)) {
            images = images.concat(item.images);
          } else if (item.type === "DESCRIPTION") {
            const d = item.text?.zh_Hans || (typeof item.text === "string" ? item.text : "");
            if (d) description = d;
          } else if (item.text) {
            const actText = item.text?.zh_Hans || (typeof item.text === "string" ? item.text : "");
            if (actText && !actions.includes(actText)) actions.push(actText);
          }
        }
      } else if (typeof parsed === "object" && parsed !== null) {
        if (parsed.text?.zh_Hans) {
          tag = parsed.text.zh_Hans;
        }
      }
    } catch (e) {
      // line parse error
    }
  }

  if (!paragraph && !images.length && !description) return null;

  let gridClass = "g-3";
  if (images.length === 1) gridClass = "g-1";
  else if (images.length <= 4) gridClass = "g-2";

  const imgsHtml = images.length
    ? `<div class="feed-grid ${gridClass}">${images.map((src) => `<img loading="lazy" src="${esc(src)}" onclick="openLightbox(this.src)" onerror="this.outerHTML='[图片]'">`).join("")}</div>`
    : "";

  const actionsHtml = actions.map((act) => `<span class="feed-act">${esc(act)}</span>`).join("");
  const linkHtml = targetUrl ? `<a href="${esc(targetUrl)}" target="_blank" rel="noopener" class="feed-link">查看详情 ↗</a>` : "";

  return `<div class="feed-card"><div class="feed-head"><span class="feed-badge">${esc(tag)}</span>${description ? `<span class="feed-desc">${esc(description)}</span>` : ""}</div>${paragraph ? `<div class="feed-text">${esc(paragraph)}</div>` : ""}${imgsHtml}<div class="feed-foot"><div class="feed-actions">${actionsHtml}</div>${linkHtml}</div></div>`;
}

// 钉钉 OA 日志（蓝凌日志）卡片收敛适配器
export function tryFormatReportCard(text) {
  if (!text || !/landray\.dingtalkapps\.com|viewReport|dingdocSelectorV4\/save/i.test(text)) {
    return { text, reportHtml: "" };
  }

  let s = String(text);
  let viewUrl = "";
  let saveUrl = "";

  // 1. 提取网页端查看链接
  const viewM = s.match(/https:\/\/landray\.dingtalkapps\.com\/[^\s)]+/);
  if (viewM) {
    viewUrl = viewM[0];
  } else {
    const redM = s.match(/redirect_url=([^&\s)]+)/);
    if (redM) {
      try { viewUrl = decodeURIComponent(redM[1]); } catch { viewUrl = redM[1]; }
    }
  }

  // 2. 提取转存钉钉文档链接
  const saveM = s.match(/https:\/\/alidocs\.dingtalk\.com\/i\/u\/dingdocSelectorV4\/save[^\s)]+/);
  if (saveM) saveUrl = saveM[0];

  // 3. 剥离末尾那几串冗长的 markdown 链接
  s = s.replace(/\[(?:dingtalk|https?):\/\/[^\]]+\]\s*(?:\r?\n\s*)?\((?:dingtalk|https?):\/\/[^\)]+\)/g, "");

  // 4. 剥离末尾孤立的点赞/评论计数字段（如 \n 0 \n 0）
  let stats = "";
  const statsM = s.match(/\n+(\d+)\s*\n+(\d+)\s*$/);
  if (statsM) {
    stats = `👍 ${statsM[1]} · 💬 ${statsM[2]}`;
    s = s.slice(0, statsM.index);
  }

  // 清除尾部多余空白
  s = s.trim();

  const reportHtml = `
    <div class="report-foot">
      ${viewUrl ? `<a href="${esc(viewUrl)}" target="_blank" rel="noopener" class="report-btn">📘 查看完整日志</a>` : ""}
      ${saveUrl ? `<a href="${esc(saveUrl)}" target="_blank" rel="noopener" class="report-btn">📁 转存到文档</a>` : ""}
      ${stats ? `<span class="report-stats">${esc(stats)}</span>` : ""}
    </div>
  `.trim();

  return { text: s, reportHtml };
}

test("parse feed card correctly", () => {
  const raw = `BIZ_TYPE_ONEFEED_POST
dingtalk://dingtalkclient/page/link?url=https%3A%2F%2Fh5.dingtalk.com%2Fcircle%2FpostDetail.html%3FbizType%3D7%26bizId%3D730474289%26postId%3D22267156703
[{"text":{"zh_Hans":"示例花卉基地\\n基地占地260多亩，全年销售1千多万株。"},"type":"PARAGRAPH"},{"images":["https://down-cdn.dingtalk.com/1.jpg","https://down-cdn.dingtalk.com/2.jpg"],"type":"IMAGE"},{"text":{"zh_Hans":"张三 发布于 2026-09-05"},"type":"DESCRIPTION"}]
{"color":"#00B042","text":{"zh_Hans":"圈子"}}
[{"text":{"zh_Hans":"评论 (2)"},"type":"JUMP"},{"text":{"zh_Hans":"点赞 (8)"},"type":"SUBMIT"}]`;

  const html = tryRenderFeedCard(raw);
  assert.ok(html);
  assert.match(html, /示例花卉基地/);
  assert.match(html, /feed-grid g-2/);
  assert.match(html, /张三 发布于 2026-09-05/);
  assert.match(html, /h5\.dingtalk\.com/);
  assert.match(html, /评论 \(2\)/);
  assert.match(html, /点赞 \(8\)/);
});

test("markdown parsing with images and links", () => {
  // 预处理 [url]\n(url) 换行错位
  let md = `2026-09-05值班信息
业务人员值班表
![image](https://img.alicdn.com/test.gif)
[https://alidocs.dingtalk.com/doc]
(https://alidocs.dingtalk.com/doc)`;

  md = md.replace(/\[([^\]]+)\]\s*\r?\n\s*\((https?:\/\/[^\s)]+)\)/g, "[$1]($2)");
  assert.match(md, /\[https:\/\/alidocs\.dingtalk\.com\/doc\]\(https:\/\/alidocs\.dingtalk\.com\/doc\)/);
});

test("format report card properly", () => {
  const raw = `示例销售工作日报
所在城市：2026年9月5日某市 晴
销售自拓商机进展：
示例客户A:已完成收费。

0
0
[dingtalk://dingtalkclient/action/openapp?redirect_url=https%3A%2F%2Flandray.dingtalkapps.com%2Fview](dingtalk://dingtalkclient/action/openapp?redirect_url=https%3A%2F%2Flandray.dingtalkapps.com%2Fview)
[https://landray.dingtalkapps.com/alid/app/report/viewReport_new.html?id=123](https://landray.dingtalkapps.com/alid/app/report/viewReport_new.html?id=123)
[https://alidocs.dingtalk.com/i/u/dingdocSelectorV4/save?resourceId=123](https://alidocs.dingtalk.com/i/u/dingdocSelectorV4/save?resourceId=123)`;

  const { text, reportHtml } = tryFormatReportCard(raw);
  assert.equal(text.includes("dingtalk://"), false);
  assert.equal(text.includes("viewReport_new.html"), false);
  assert.match(text, /示例客户A:已完成收费。/);
  assert.match(reportHtml, /查看完整日志/);
  assert.match(reportHtml, /转存到文档/);
  assert.match(reportHtml, /👍 0 · 💬 0/);
});

test("placeholder cannot be corrupted by markdown strong syntax", () => {
  const ph = "§§MEDIAIMG0§§";
  assert.doesNotMatch(ph, /__/);
  assert.doesNotMatch(ph, /\*\*/);
});
