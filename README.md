# dingtalk-im

Local-only DingTalk chat web UI backed by the official `dws` CLI. Zero npm dependencies.

```bash
npx dingtalk-im
# 1. installs dws CLI if missing
# 2. runs `dws auth login` if not logged in (browser pops up)
# 3. serves http://127.0.0.1:3777
```

Options: `--port 3777` `--no-open` `--data-dir <path>`

## What it does

- Sidebar in one call: `GET /api/sidebar` merges conversation list + per-conv
  unread counts (`unreadPoint`) + mute flags (`notificationOff`) + @-mention
  counts, all from dws. Muted chats auto-collapse into one folder.
- Chat: history paging (latest first, oldest on scroll-up), send text with
  real @-mentions (`<@id>` placeholders), recall own messages, mark-read on open.
- Live updates via `dws event consume` (DingTalk Stream) over SSE.
- Images proxied and cached locally (`~/.dingtalk-im/data`); avatars are
  initial-letter fallback (dws exposes no avatar URLs).

## Security

Binds `127.0.0.1` only. Never expose publicly, never deploy as a web service:
every API call runs with your personal DingTalk identity.
