# EZwebMonitor
极简的 FPS + 内存 实时监控悬浮层（深色、可拖拽）。
支持 R/S 采样切换、5s/10s/15s 窗口切换、CSV 记录导出、动态纵轴（±10%）、平滑缩放动画、Hover 提示，关闭后完全清理不留痕。

> 适用于临时在任意网页上查看性能指标、抓数据回放。
## usage 使用方法
在浏览器控制台输入以下命令
``` javascript
import("https://cdn.jsdelivr.net/gh/1103837067/EZwebMonitor/index.js");
// 关闭UI后可使用下面命令重新打开UI面板，也可以一起粘贴，每次都会显示UI
window.__EZwebMonitorBootstrap();
```
## ⚙️ 全局对象

所有功能都挂载在：
``` javascript
window.__perfOverlay
```

以及辅助启动函数：
``` javascript
window.__EZwebMonitorBootstrap()
```
## 🧠 API一览
| 方法                                | 功能说明                        |
| --------------------------------- | --------------------------- |
| `__perfOverlay.remove()`          | 移除浮层并清理所有事件/循环。             |
| `__perfOverlay.reload()`          | 重新创建浮层（无需再次 import）。        |
| `__EZwebMonitorBootstrap()`       | 与 `reload()` 等价，手动启动监控。     |
| `__perfOverlay.toggleRate()`      | 切换采样速率模式：`R`（实时） ↔ `S`（每秒）。 |
| `__perfOverlay.toggleWindow()`    | 切换显示时间窗口：5s → 10s → 15s 循环。 |
| `__perfOverlay.start()`           | 开始记录性能数据。                   |
| `__perfOverlay.stopAndDownload()` | 结束记录并导出 CSV 文件。             |
| `__perfOverlay.getJankConfig()`   | 查看当前 jank 检测阈值（PerfDog 风格）。 |

## 🧾 导出 CSV 字段

每条记录包含以下列：
| 列名              | 说明             |
| --------------- | -------------- |
| `timestamp_iso` | 时间戳（ISO 格式）    |
| `elapsed_ms`    | 运行时间（相对起点）     |
| `fps`           | 当前帧率           |
| `memory_mb`     | 内存（MB）         |
| `jank`          | 卡顿事件（1=是，0=否）  |
| `big_jank`      | 大卡顿事件（1=是，0=否） |
| `delta_ms`      | 当前帧耗时（ms）      |


> 移动端支持 Web Share API：导出时会弹出“保存/分享”面板；
若浏览器不支持，会自动切换为下载或复制到剪贴板。
---
### 📊 Jank 检测算法（PerfDog 风格）

定义基于连续帧耗时（delta_ms = ts_now - ts_prev）：

- Jank： 满足

    当前帧耗时 > 前 3 帧平均的 2 倍

    当前帧耗时 > 2 × (1000/24) ≈ 83.3ms

- Big Jank： 满足

    当前帧耗时 > 前 3 帧平均的 2 倍

    当前帧耗时 > 3 × (1000/24) = 125ms

> 当标签页处于后台或帧间隔 > 2000ms 时，忽略该样本（防误报）。