# Known Issues

## [2026-05-30] Cloudflare Durable Objects Free Tier 请求配额耗尽

**症状**

- 所有 API 请求（`/login`、`/ws` 等）返回 `HTTP 500`，响应体为 `error code: 1101`（16 字节）
- 请求格式完全正确，Content-Type / Authorization 均无误
- 静态页面（`GET /`）仍然正常，说明 Worker 本身在线，只有 Durable Object 调用失败

**根因**

Cloudflare Durable Objects 免费计划每日请求配额耗尽：

```
Error: Exceeded allowed volume of requests in Durable Objects free tier.
```

游戏每 100 ms 触发一次 DO Alarm（tick loop），加上 WebSocket 长连接持续推送，DO 请求量消耗极快，免费额度（1,000,000 次/天）很容易在数小时内耗尽。

**诊断方法**

```bash
npx wrangler tail --format pretty
# 观察日志中是否出现：
# Error: Exceeded allowed volume of requests in Durable Objects free tier.
```

**解决方案**

| 方案 | 说明 |
|------|------|
| 升级付费计划 | Cloudflare Workers Paid Plan $5/月，DO 请求量大幅提升，推荐长期运行使用 |
| 等待配额重置 | 免费计划每日 UTC 00:00 重置，临时可用 |

**预防建议**

- 在 Cloudflare Dashboard → Workers & Pages → Usage 监控 DO 请求量
- 考虑在低活跃期暂停 tick loop（当无 WebSocket 连接时跳过 broadcast）
