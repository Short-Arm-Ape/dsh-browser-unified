# dsh-browser-unified

**0.11 线已收线。** 最后一版是插件 **0.11.53** 配扩展 **1.0.56**，代码定格在标签 `v0.11.53-final`，
之后不再往 0.11.x 动。

机器上现在装的是上游 [angelky7/dsh-browser-control](https://github.com/angelky7/dsh-browser-control)
（包 `@angelky7/dsh-browser-control`，扩展 1.7.2）。我们从 0.11 线搬过去的三块东西——目标授权
（`url_blocked`）、权限探针（`browser_permissions`）、浏览器 profile 定位——记在 `NOTE.md` 的
2026-11-12 与 2026-11-13 两节，含切换当天在真机上的读数。

| 项 | 值 |
|---|---|
| 停更线 | 插件 `dsh-browser-unified` **0.11.53** + 扩展 **1.0.56** → 标签 `v0.11.53-final` |
| 现在的主线 | 上游 `@angelky7/dsh-browser-control` **1.7.x** + 上游扩展 **1.7.2** |
| 实例 id / 设置命名空间 | `browser-bridge`（与上游一致，换装时 profile 里的 enable 行不用改） |
| 许可 | **AGPL-3.0-only**，来源与归属见 `NOTICE.md` |
| 本仓内容 | 项目流水 `NOTE.md`、历史档 `archive/` `backups/`、上游基线 `upstream-baseline.json` |

## 装

```bash
dsh plugin --profile <name> add @angelky7/dsh-browser-control
```

2026-11-13 实测：这条命令会把依赖写进 profile 的 `package.json`，并往 `dsh.profile.bundles` 追加一行；
之后重启 `dsh web`。扩展按上游 README 在 `edge://extensions` 里加载 `extension/`。

npm 上那份是**上游原版**（`lib/index.js` 179 KB）。带目标授权与权限探针的是我们自用的补丁构建
（258.8 KB），只落在这台机器上，构建方式与基线记在 `NOTE.md`；从 npm 装不会带上这两块。

## 历史

- 0.11 线做了什么、怎么收的线：`NOTE.md` 的 2026-11-11 一节。
- 更早的 0.7.x 形态（16 个工具、GuardedBridge、GUI「浏览器」设置分区）：`NOTE.md` 对应章节与 `archive/`。
- 上游基线（commit sha、tarball 校验）：`upstream-baseline.json`；基线选择与当时的核数在 `NOTE.md` 2026-11-12 一节。

## 许可

`LICENSE` 是 AGPL-3.0 全文；`NOTICE.md` 是完整来源矩阵（上游代码、本仓撰写的部分、衍生关系）。
