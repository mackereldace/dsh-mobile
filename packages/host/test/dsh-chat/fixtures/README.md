# 会话页的**真数据**夹具

这里放的是从**真会话日志**里原样取出的事件 —— 一字未改。

## `real-assistant-message-event.json`

一条真实的 `assistant/message` 事件（手机页面从 `mobile/dsh/read` 收到的就是**这个形状**）。

| 项 | 值 |
|---|---|
| 来源 | `~/.dsh/sessions/--Volumes-Data-workspace-~5DE5~7A0B~8BBE~8BA1--/session-b3206a33-10a4-4758-bf0a-3857fdf9fb44/session.v4.jsonl.zstd`（**只读**取得） |
| 事件 | `type = "assistant/message"`，`seq = 8345`，`surfaceOp = "append"` |
| `data` 字段 | `turn` / `step` / `message` / `usage` / `stream` |
| `data.message.content[]` | `[{type:'reasoning',text:…283 字…}, {type:'text',text:…262 字…}]` |
| `JSON.stringify(data).length` | 4429 |
| SHA-256 | `d76f23976ae83cf1da14bee579cf27ccb340e91b329cd1f3f1acccd2275595ae` |

★ **为什么必须是真的** ✗：会话页曾经把这样的真消息**整段画成一坨 JSON** ✓，
而当时的夹具是自己编的 `{data:{text}}` ✓ —— 形状与真实不符 ⇒ 断言全绿、线上照错 ✓
（与"静默跳过""假判据"是同一族 ✓）。所以这里的判据是：**夹具就是真事件** ✓。

## 重新取一条（DSH 换版本后形状可能变，届时照这个办法换）

只在**读**的前提下取（`~/.dsh` 一个字节都不写 ✓）：

```bash
zstd -d -c ~/.dsh/sessions/<slug>/session-<id>/session.v4.jsonl.zstd \
  | node -e "let b='';process.stdin.on('data',c=>b+=c).on('end',()=>{const rows=b.split('\n').filter(Boolean).map(l=>JSON.parse(l));const hit=rows.find(r=>r.type==='assistant/message'&&(r.data.message.content||[]).some(p=>p.type==='text'&&p.text));process.stdout.write(JSON.stringify(hit,null,2))})" \
  > packages/host/test/dsh-chat/fixtures/real-assistant-message-event.json
```

换完**必须**同时看两处：

1. `node scripts/check-chat-page.mjs` —— 它把这条事件喂给真页面 ✓
   （字符数/正文开头都是**从这条事件机械推出来的** ✓，不是手抄的 ✓）；
2. `node --test --experimental-strip-types packages/host/test/dsh-chat-viewmodel.test.ts` ✓。

★ 别忘了更新上表的 SHA-256（`shasum -a 256 <file>` ✓）与那几行读数 ✓。
