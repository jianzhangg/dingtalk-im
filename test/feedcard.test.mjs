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

test("parse feed card correctly", () => {
  const raw = `BIZ_TYPE_ONEFEED_POST
dingtalk://dingtalkclient/page/link?url=https%3A%2F%2Fh5.dingtalk.com%2Fcircle%2FpostDetail.html%3FbizType%3D7%26bizId%3D730474289%26postId%3D22267156703
[{"text":{"zh_Hans":"东营双福花卉\\n双福花卉在东营占地260多亩，全年销售1千多万株。"},"type":"PARAGRAPH"},{"images":["https://down-cdn.dingtalk.com/1.jpg","https://down-cdn.dingtalk.com/2.jpg"],"type":"IMAGE"},{"text":{"zh_Hans":"张艺泓 发布于 2026-09-05"},"type":"DESCRIPTION"}]
{"color":"#00B042","text":{"zh_Hans":"圈子"}}
[{"text":{"zh_Hans":"评论 (2)"},"type":"JUMP"},{"text":{"zh_Hans":"点赞 (8)"},"type":"SUBMIT"}]`;

  const html = tryRenderFeedCard(raw);
  assert.ok(html);
  assert.match(html, /东营双福花卉/);
  assert.match(html, /feed-grid g-2/);
  assert.match(html, /张艺泓 发布于 2026-09-05/);
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
