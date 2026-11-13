# dsh-browser-unified

**这条线已收线。** 最后一版是插件 **0.11.53** 配扩展 **1.0.56**，代码定格在标签 `v0.11.53-final`，
之后不再往 0.11.x 动。

本仓接下来要换方向，方案还没定；「以上游为主线、跟着别人的仓往前走」这条跟随线到此结束。

| 项 | 值 |
|---|---|
| 停更线 | 插件 `dsh-browser-unified` **0.11.53** + 扩展 **1.0.56** → 标签 `v0.11.53-final` |
| 实例 id / 设置命名空间 | `browser-bridge` |
| 许可 | **AGPL-3.0-only**（根目录 `LICENSE` 是全文），来源与归属见 `NOTICE.md` |
| 本仓内容 | 项目流水 `NOTE.md`、历史档 `archive/` `backups/`、上游基线 `upstream-baseline.json`、源码 `src/packages/` |

0.11.53 这一版里有三块是自己长的：目标授权（导航目标按主机分档 + 放行/拒绝名单 + 云元数据红线）、
权限探针（读浏览器 `Preferences` 回答「这个权限会不会弹窗」）、浏览器 profile 定位（上游 hello 不带扩展 id，
按配置与磁盘反查是哪个 profile 装了扩展）。设计与取舍在 `NOTE.md`。

## 历史

- 0.11 线做了什么、怎么收的线：`NOTE.md` 的 2026-11-11 一节。
- 更早的 0.7.x 形态（16 个工具、GuardedBridge、GUI「浏览器」设置分区）：`NOTE.md` 对应章节与 `archive/`。
- 上游基线（commit sha、tarball 校验）：`upstream-baseline.json`。

## 许可

`LICENSE` 是 AGPL-3.0 全文；`NOTICE.md` 是完整来源矩阵（上游代码、本仓撰写的部分、衍生关系）。
