# Web 客户端验收手册

会话日志：级别 信息 / 警告 / 错误 / 调试（“调试”芯片可实时打开，无需重连），分类 连接 /
编解码器 / 视频 / 解码器 / 输入 / 剪贴板 / 光标 / 系统 / 界面。搜索黄色高亮；折叠后仅显示
条数。清空按钮只清条目——记录继续，卡片保留。

## 1. 日志行对照表

### 连接（整条链路约 3 秒即正常）
| 日志行 | 含义 |
|---|---|
| `hbbs: wss://…/ws/id`、`hbbs connected` | rendezvous，打洞请求 |
| `relay_response: relay=… uuid=…` | 中继分配会话 uuid |
| `hbbr: …/ws/relay`、`hbbr connected` | 中继通道 |
| `encrypted session established` | 加密建立 |
| `LoginRequest sent` → `login OK, video stream requested` | 主机放行 |
| `SignedId IdPk at offset N` | N 为任意值（65/66/…）均正常——提取器本就是扫描的 |
| `relay msg (unhandled fields=21:2)` | 无害的协议噪声 |
| `peer: user@host (OS) WxH` | 对端身份与屏幕 |
| `cursor_data in / remote cursor applied` | 主机光标 |
| `── connect → PEER` / `── connection lost: …` | 会话边界（断线不清空日志） |

### 编解码器
| 日志行 | 含义 / 处置 |
|---|---|
| `probe: caps gate on (N video mimes)` | 引擎能力门已启用 |
| `probe: X capped at 720p/1080p/4K` | 引擎上限；自动模式不会超出 |
| `browser codecs: a,b,c` | 探测结论 |
| `codec preference at login: auto -> X (last-good)` | proven 优先启动 |
| `codec preference: X (prefer=N)`（调试） | 手动锁定 / 预设已发往主机 |
| `codec X during grace after pin Y`（调试） | 过渡中，主机正在切换（10 秒内）——正常 |
| `host streams X despite manual Y`（警告） | 主机 10 秒以上无视锁定——检查主机是否支持 Y |
| `codec X excluded: WxH above proven decode cap`（警告） | 阶梯已过滤——正常 |
| `decoder picked X`（调试） | 引擎事实（过渡期线路可能不准） |
| `codec steering A -> B` | 花屏时自动切换——正常 |
| `codec fallback exhausted` | 链路用尽——异常，查网络/主机 |
| 红色横幅 | 锁定无法解码且无处可去——点“回到自动” |
| 蓝色横幅 | 自动已自行切换——仅提示，无需操作 |

### 视频与网络
| 日志行 | 含义 / 处置 |
|---|---|
| `no frames 0.7s/6s after login, re-sending options` | 登录后早期重发——正常 |
| `video stalled (N s) — sent refresh` | 偶发正常；成串出现查网络 |
| `auto: A/B -> C/D (kbps, ping, decode/paint)` | 阶梯决策；括号里是原因——看它 |
| 统计中 `E 0/3` | 3 个坏 delta = 链路丢包 |
| FPS 旁 `(−N)` | 丢弃的滞后帧（追赶） |

### 输入、剪贴板、聊天
| 日志行 | 含义 |
|---|---|
| `send key #N down Legacy Ctrl+a`（调试） | 组合键与字符；Map 模式为物理键（`KeyA`），无系统信息则为 `raw:NN` |
| `ui: hotkey …`、`ui: clipboard …`、`ui: switch display` | 工具栏动作 |
| `ui: codec/quality/fps/turbo/zoom/…` | 其余动作审计 |
| `ui: chat sent/greeting/close notice` | 发出的聊天与系统消息 |

### 错误（红旗）
`decrypt failed`、`relay decode error + hex`、`SignedId unparseable`、
`connect timed out`、`host closed: …`、`manual codec X failed, no auto fallback`。

## 2. 验收矩阵

切换之间停 20–30 秒；每例之前先清空日志。
| # | 动作 | 通过标准 |
|---|---|---|
| 1–3 | 自动 → VP8 / VP9 / AV1 | 有 `ui:` + `decoder picked`，约 10 秒内徽标一致，无横幅 |
| 4 | 在不支持 AV1 的主机上手选 AV1 | 警告 + 红色横幅，徽标显示事实 |
| 5 | 横幅上“回到自动” | 无需重连即恢复 |
| 6–7 | Turbo 开 / 关 | 预设生效；精确恢复（核对选择器） |
| 8 | 自动模式重连 | 直接 `auto -> X (last-good)`，不乱切 |
| 9 | 聊天双向 | 主机弹出聊天窗口；未读徽标；位置在重载后保留 |
| 10 | 断线 10–15 秒 | `connection lost` 标记，自动重连，日志完整 |
| 11 | 多显示器（如有） | `display switched`，新分辨率下 `decoder picked` |

## 3. 读统计（1 秒切片！）

- **饥饿：** Q 数百毫秒 + 丢帧增长 + E>0 + kbps 触底。治法：自动画质、降低缩放。
- **静止：** FPS 低但 Q 温和、丢帧不动、kbps 在流——只是画面静止，一切正常。
- **Ping** = RTT + 中继共享通道排队：重编码（VP8/9）下会涨——这是 bufferbloat，不是“网变差了”。
- **正常值：** 解码 < 40ms，绘制 < 25ms，Q < 120ms。
- **阶梯档位：** `kbps<1200 或 ping>220` → 2/15（底）；`<3200 或 >110` → 3/30；否则 4/60。深底（1/10）——Q>300 连续两拍。从零启动走快速通道（约 10 秒）。上调需 6 拍 + 冷却（防抖动）。

## 4. 机房地理（荷兰 ↔ 哈巴罗夫斯克）

正常：RTT 250–350ms，kbps 在 0–1800 之间波动，偶发单次卡顿，队列堵塞时 VP8/9 下 ping 可达 1600。
红旗：E 成串、丢帧上双、decode>40、1/10 底层 Q>300 持续数分钟。
服务器始终空闲（已验证：LA ~0.15，hbbr CPU ~0%，网卡零错误）——淹死的是骨干网，不是虚拟机。
