# dsh-compaction-fix

**Fix DeepSeek Harness's auto-compaction for Chinese conversations.**

DSH 自带的自动压缩，在中文任务里几乎不触发；等它真触发了，留多少也常常不合预期。这个仓库给出根因和一份可以直接用的覆盖补丁。

> 适用：DeepSeek Harness 桌面版 / `@deepseek-ai/dsh-compaction-basic`。
> 不适用：已经修好这块的版本（先按第一节的现象判断）。

## 实测环境

| | 版本 |
|---|---|
| DeepSeek Harness | `0.2.1-rc.3`（桌面版） |
| Electron | `44.7.0` |
| 压缩插件 | `@deepseek-ai/dsh-compaction-basic` |
| 平台 | Windows 10/11 |

**兼容性**：这几条根因都在代码层面，不是某个版本特有的 bug——

- `CHARS_PER_TOKEN = 4`：估算器一直这么写
- `agent.cordis.yml` 不读：桌面版改成 bundle 内嵌预设之后就是这样
- patch 只到顶层行：`cordis-plugin-loader` 的寻址规则

所以理论上 `0.1.x` 到 `0.2.x` 都能用。但**内置 `standard.patch.yml` 的 `plugins` 列表会随版本变**（加工具、改提示词），直接抄本仓库的 `cordis.patch.yml` 可能缺或多插件。**换版本请跑 `重新生成预设.mjs` 重新抽一次**，它按当前安装包生成。

---

## 一、现象

按严重程度排：

**1. 自动压缩几乎不触发（最常见）**

上下文涨到 40%、60%、甚至 80%，一次都没压过。插件面板显示「已启用 / 运行中」，没有任何报错。

**2. 手动 `/compact` 会压到底，只剩 1%–2%**

手动触发一次，上下文从 40% 直接掉到 1%–2%，前面的对话基本等于没了。**这是 1%–2% 这个数字的唯一来源。**

**3. 自动压缩默认留 12% 左右，不是 1%**

如果把阈值调低让它跑起来，默认配置（`retainRatio: 0.16`）会保留 `messageBudget × 0.16` ≈ **12%** 的原文（100 万窗口约 11.9 万 token）。不是 1%。

> 所以「压完只剩 1%」和「自动压缩」是两件事：**1% 来自手动 `/compact`，自动压缩的默认留存是 12%**。
> 真正的问题是这两个都不合用：自动那份阈值太高（0.8）根本到不了，手动那份又太狠。

## 二、根因一：估算器把中文低估到四分之一

DSH 的 token 计数（`@deepseek-ai/dsh-token-meter`）用固定密度估算：

```js
const CHARS_PER_TOKEN = 4
```

四个**字符**算一个 token。

- 英文、代码：基本准
- 中文：**一个汉字就是一个 token**，被算成实际的四分之一

结果：整个中文会话的估算值大约只有真实值的一半（中英混排时 1/1.7 到 1/2.1 之间）。

压缩插件拿**估算值**跟阈值比，所以：

> 界面上看到 40%，在它眼里可能只有 20%。

实测对照（同一会话，同时刻）：

| 实际 token | 估算 token | 比例 |
|---|---|---|
| 430,100 | 253,900 | 1.69 |
| 351,400 | 169,300 | 2.08 |
| 454,300 | 268,100 | 1.69 |

**这就是「几乎不触发」的主因**：默认阈值 `0.8` = 估算 80 万，而 100 万窗口的中文会话实际撑到 100 万时估算才 50 万上下——永远够不到。

## 三、根因二：`agent.cordis.yml` 是旧格式，根本不被读取

网上能搜到的教程会让你改：

```
<profile>/local-plugins/dsh-mobile-plugin/config/agent-presets/standard/agent.cordis.yml
```

**这个文件 DSH 早就不读了。** 它是旧目录布局的遗留物，改了没有任何效果。

真正的「标准模式」预设是**随安装包内置**的：

```
<安装目录>/resources/app.asar
  └─ dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml
```

asar 是归档文件，不能直接编辑，也不该编辑（升级会覆盖）。

## 四、根因三：patch 按 id 寻址，够不到预设内部的插件

DSH 的三层配置：

1. `dsh-base` bundle（内置）
2. 你的 profile `cordis.patch.yml`
3. agent preset 树（每个会话按预设铺一棵）

`cordis.patch.yml` 只能按 **id** 覆盖**顶层行**。压缩插件挂在预设树深处：

```
preset-standard
  └─ config.plugins[]
       └─ compaction (group)
            └─ config[]
                 └─ compaction-basic   ← 想改的是这个
```

所以这样写**无效**：

```yaml
- id: compaction-basic       # 够不到
  config:
    thresholdRatio: 0.2
```

**唯一有效的办法：整段重述 `preset-standard`**，把 `plugins` 完整抄一遍，只改压缩那条的 `config`。本仓库的 `cordis.patch.yml` 就是成品。

## 五、坑一：手动 `/compact` 不吃 `retainTokens`

`/compact` 走的是 `compactNow`，内部把保留量当 **0** 传——**压掉全部历史**，只留一段摘要。

- 自动压缩（pressure 触发）：吃 `retainTokens` / `retainRatio`
- 手动 `/compact`：**不吃**，永远压到底

**所以别用 `/compact` 验证留存设置**，会误判成「配置没生效」。要验证只能等自动触发，或者临时把 `thresholdRatio` 调到很小让它自己压一次。

### 实测记录（不是推断）

**手动 `/compact` 压到底 —— 已实测**（26 万窗口的会话，`sourceCommandId` 有值即为手动触发）：

| | token | 占窗口 |
|---|---|---|
| 压前 | 77,062 | 29% |
| 压后 | 13,106 | **5%** |

留下的 1.3 万几乎全是摘要，原文基本清空。

**同一组绝对量换到不同窗口就是不同百分比**：1.3 万在 26 万窗口里是 5%，在 100 万窗口里就是 **1.3%**——所以「压完剩 1% 上下」的说法只对大窗口成立，小窗口看起来会「多剩一点」，但实际留下的原文一样是零。

这条是**亲手按下去、看着界面掉下来的**，不是从源码推的。源码里 `compactNow` 传 0 的行为见上一节。

## 六、坑二：整段覆盖时 `config` 是替换不是合并

覆盖一条插件时，`config` 是**整个换掉**，不是逐字段合并。

```yaml
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    order: 1
    plugins:          # ← 这个数组必须完整
      - id: persona
      ...
      - id: compaction
        ...
      - id: tool-fs   # ← 少抄一条，那个工具就没了
```

**少抄一条工具定义，那个工具就会从所有会话里消失。**

所以本仓库的 patch 是**从安装包里程序化抽取再改三行**生成的，不是手抄。

## 七、风险与恢复

### 改之前

```powershell
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" `
          "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml.bak" -Force
```

### 出问题怎么退

删掉 patch 里新增的那一整段（到 `- id: agent-default-model` 之前），重启；或把 `.bak` 盖回去。

### DSH 升级之后

内置的 `standard.patch.yml` 会变（加工具、改提示词），而你的覆盖是**旧副本**——会盖住新版本。

**升级后跑一次 `node 重新生成预设.mjs`**：它会重新从 asar 抽最新的预设，套上你的参数，替换掉旧段。

---

## 用法

### 1. 生成覆盖（推荐）

```sh
node 重新生成预设.mjs
```

脚本会：

1. 从安装包的 asar 里读出 `presets/standard.patch.yml`
2. 给 `compaction-basic` 加上三个参数
3. 替换 profile `cordis.patch.yml` 里现有的那一段
4. 把旧 patch 备份到 `backup/` 目录

### 2. 或者直接抄 `cordis.patch.yml`

把本仓库的 `cordis.patch.yml` 内容**追加**到你 profile patch 的最前面，然后按需改三个数字。

### 3. 参数怎么定

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    thresholdRatio: 0.3      # 估算 30 万触发（100 万窗口 ≈ 实际 60%）
    retainTokens: 75000      # 压完留 7.5 万估算 token 的原文（≈ 实际 15%）
    auto: true
```

**示例按 100 万窗口写。小窗口（如 26 万）必须按最小窗口重算**——见下面的硬约束。

换算（100 万窗口）：

| 你希望界面上 | `thresholdRatio` |
|---|---|
| 30% 触发 | 0.15 |
| 40% | 0.20 |
| 44% | 0.21 |
| 60% | 0.30 |

经验公式：`thresholdRatio ≈ 想要的百分比 ÷ 2.1`

`retainTokens` 同理：`实际想留的百分比 × 窗口 ÷ 2.1`

### 4. 硬约束（不满足会抛 `TargetPressureConfigError`）

```
messageBudget  = contextWindow - maxTokens        > 0
pressureBudget = messageBudget - headroomTokens   > 0
threshold      = min(contextWindow × ratio, pressureBudget)
retainTokens   < threshold                        必须
```

**小窗口会冲突**：26 万窗口 + `retainTokens: 100000` → 阈值只有 7.86 万（0.3 × 26.2 万），留存 10 万 > 阈值，直接抛错，**那间会话的压缩会整个失效**。

同一份配置对多模型生效时，`retainTokens` 要按**最小窗口**取。

## 怎么验证生效

### 1. 看会话日志里的事件

压缩会写三条事件：

```
compaction/start → compaction/summary → compaction/end
```

会话文件是 zstd 压缩的（`~/.dsh/sessions/<目录>/session.v4.jsonl.zstd`），解开后 grep `compaction/start` 的条数和时间。

**注意**：`compaction/prune` 是另一个东西（工具结果修剪），不要把它的效果当成压缩。

### 2. 看界面百分比

会明显掉一截。实测一组（100 万窗口，`thresholdRatio: 0.19` / `retainTokens: 60000`）：

| | 实际 token | 估算 token | 界面 |
|---|---|---|---|
| 压前 | ≈ 1,000,000（满） | 515,350 | 100% |
| 压后 | 110,500 | 73,900 | **11%** |

压后剩 11%，与 `retainTokens: 60000`（估算）+ 摘要（约 1.4 万估算）吻合。

> ⚠️ 有一组容易看错的数据：某个 26 万窗口的会话从 143.5k 掉到 75.6k（55% → 29%），那**不是压缩**，是 `compaction/prune`（工具结果超过 8192 字符被截头尾）。它没有 `compaction/start` 事件。

## License

MIT
