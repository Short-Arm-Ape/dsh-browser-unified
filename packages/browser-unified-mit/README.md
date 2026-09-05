# dsh-browser-unified-mit (MIT edition)

MIT-licensed edition of **dsh-browser-unified** — **contains no caob23-derived
code** (no bridge, no browser driver tools). It ships the pure unified logic
modules and the self-update / design-registry tools as an installable DSH
bundle and as a small library.

| 项 | 值 |
|---|---|
| 包名 | `dsh-browser-unified-mit` |
| 版本 | 0.1.0 |
| 许可证 | **MIT**（不含任何 AGPL/caob23 派生代码；归属见 NOTICE.md） |
| 实例 id | `browser-unified-mit` |
| 提供 | `browser_check_update` / `browser_design_show` / `browser_design_edit` + 库导出（url-policy / approval / instance / self-update） |
| 不提供 | caob23 桥、16 个 `browser_*` 驱动工具、GuardedBridge 运行时接线 |

> 需要完整浏览器能力（桥 + `browser_*` 工具 + URL 策略守卫）请用 AGPL 全量版
> `dsh-browser-unified`（见同仓库 `packages/browser-unified-plugin`）。

## 本地构建与打包（内含脚本）

```bash
cd packages/browser-unified-mit
npm run build-pack     # 依赖就绪检查 -> tsc 编译到 lib/ -> npm pack
# 或直接： node scripts/build-pack.mjs   （加 --no-pack 只编译不打包）
```

产物：`dsh-browser-unified-mit-0.1.0.tgz`（尊重 package.json `files`，不含源码目录的
node_modules / junction）。首次运行缺依赖时脚本会自动 `npm install`（缓存落在包内
`.npm-cache`，沙箱/CI 也适用）。

## 安装

```bash
# 在 dsh 的 web profile 下（示例）：
cd <profile-dir>            # 例如 F:\dsh-data\profiles\web
dsh plugin --profile web add ./dsh-browser-unified-mit-0.1.0.tgz
# 并把 'dsh-browser-unified-mit' 加入 package.json 的 dsh.profile.bundles
```

实例默认无浏览器桥、无开关，装上即注册三个工具。数据目录：

- 默认读包内 `registry/`（内含 `design/registry.json` + `upstream-baseline.json` 种子副本）；
- 也可在 profile `cordis.patch.yml` 里改 `config.registryDir` 指向含这两个文件的目录
  （仓库根即符合该布局）。

## 工具

| 工具 | 读/写 | 说明 |
|---|---|---|
| `browser_check_update` | 只读 | 比对上流基线，输出 UP-TO-DATE/DRIFT/UNREACHABLE |
| `browser_design_show` | 只读 | 设计注册表摘要 |
| `browser_design_edit` | 写（审批门控、fail-closed、备份 `.bak`） | 新增/推进设计条目 |

## 许可与归属

- `LICENSE`：MIT。
- `NOTICE.md`：逐文件来源——`url-policy.ts`/`approval.ts` 为对 **MIT 上游**
  （xylt369/dsh-browser、Short-Arm-Ape/dsh-intranet-browser）语义的蒸馏并本仓重授 MIT；
  其余文件为本仓作者撰写并在此重授 MIT。caob23（AGPL）代码刻意不在此版本中。
- 运行期 peer（cordis / dsh-tools）属各自作者许可。
