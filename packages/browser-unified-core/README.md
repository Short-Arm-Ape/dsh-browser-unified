# browser-unified-core

四条 DeepSeek Harness 浏览器路线的合并核心（可编译原型）。

**License: AGPL-3.0-only**（决策 2026-09-05）。本包包含：
- MIT 语义复刻：统一 URL 策略 `public | intranet`（`src/url-policy.ts`，源自 xylt369/dsh-browser
  与 Short-Arm-Ape/dsh-intranet-browser）；审批门决策表（`src/approval.ts`）。
- AGPL-3.0 收编：caob23/dsh-browser-control 的桥实现（`src/bridge/ws.ts`、`src/bridge/server.ts`）。
- 合并集成：`src/guarded-bridge.ts`（GuardedBridge —— 桥命令先过 URL 策略）；
  `src/instance.ts`（四条路线档位注册表）。

构建 / 验证：

```bash
npm install        # typescript + @types/node
npm run typecheck  # tsc --noEmit
npm run build      # tsc → dist/
```

归属矩阵见仓库根 NOTICE.md。分发/网络服务请遵守 AGPL-3.0（第 13 条）。
