---
name: podcast-digest
description: |
  播客/视频摘要生成工具。从媒体 URL 下载音频，转写文字，生成结构化摘要（Summary / Highlights / Key Quotes / Takeaways / Transcript）。
  支持小宇宙（xiaoyuzhoufm.com）、YouTube、B站（bilibili.com / b23.tv）及一切 yt-dlp 支持的站点。
  当用户说 "/podcast-digest"、处理播客、生成播客摘要、播客总结时使用。
user-invocable: true
---

# Podcast Digest — 播客/视频摘要生成

> 下文命令中的 `$SKILL_DIR` 指本 skill 的根目录（agent 加载 skill 时即为 skill 安装路径；手动执行时 `cd` 进本目录后用 `$(pwd)`）。

## 触发条件

- 用户说 `/podcast-digest <URL>`
- 用户说 "处理这个播客"、"生成播客摘要"、"总结这期播客"

## 用法

```
/podcast-digest https://www.xiaoyuzhoufm.com/episode/xxxxx
/podcast-digest https://www.youtube.com/watch?v=xxxxx
/podcast-digest https://www.bilibili.com/video/BVxxxx
/podcast-digest https://b23.tv/xxxxx
/podcast-digest https://www.xiaoyuzhoufm.com/episode/xxxxx --clip 10
```

参数：
- 第一个参数：媒体 URL（必填，支持小宇宙、YouTube、B站及 yt-dlp 支持的站点）
- `--clip N`：仅处理前 N 分钟（可选，用于快速预览）

## 执行步骤

### Step 1: 解析 URL & 获取元数据

1. 判断 URL 来源（三通道）：
   - **小宇宙**（`xiaoyuzhoufm.com`）：web-reader 抓页面 + curl 下载音频
   - **yt-dlp 通道**（YouTube、B站 `bilibili.com` / `b23.tv`、及 yt-dlp 支持的一切站点）：统一用 `yt-dlp` 提取元数据和音频
   - **本地文件**：用户提供音视频路径时跳过下载，直接进 Step 2
2. 根据 URL 类型提取元数据：

#### 小宇宙（xiaoyuzhoufm.com）

用 web-reader MCP 工具抓取页面内容，提取：
   - **title**：播客标题
   - **podcast**：播客节目名
   - **date**：发布日期
   - **duration**：时长（分钟）
   - **description**：节目简介
   - **audioUrl**：音频直链（从小宇宙页面 metadata 中提取 `og:audio` 或从 HTML 中匹配 `xyzcdn.net` 音频链接）
   - **hosts**：主播信息
   - **guests**：嘉宾信息
   - **chapters**：Show Notes 中的时间戳章节（如有）

#### yt-dlp 通道（YouTube / B站 / 其他站点）

用 `yt-dlp --dump-json` 提取元数据：

```bash
yt-dlp --dump-json --no-download "MEDIA_URL"
```

**若报 `HTTP Error 412` / `403`（典型为 B站风控拒绝过期版本）：** yt-dlp 时效性很强，下载 GitHub 最新 standalone 二进制重试（实测 2026-08：2026.03 版被 B站拒绝，2026.07 版正常）：

```bash
mkdir -p ~/.local/bin
curl -sL -o ~/.local/bin/yt-dlp-latest 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos'
chmod +x ~/.local/bin/yt-dlp-latest
~/.local/bin/yt-dlp-latest --dump-json --no-download "MEDIA_URL"
```

后续 Step 2 的字幕下载、音频下载同样改用 `~/.local/bin/yt-dlp-latest`。

**充电专属/大会员内容：** 用户在自己浏览器登录过 B站时，加 `--cookies-from-browser edge`（或 chrome/safari）即可带上会员权益。实测 2026-08：充电专属视频无 cookie 时只返回几分钟的"试看"流（特征：format 的 filesize 与时长严重不符），带 cookie 后完整 DASH 流全部解锁。

**无 cookie 时可能拿到静默截断的流（2026-10-06 实测）：** B站部分视频免 cookie 只有 html5 mp4 的 durl 单段（format 16/32/64），长度远小于标称时长（例：标称 1153s 只下到 550s），且全程无报错。**下载完必须 `ffprobe` 核实音频时长 ≈ `--dump-json` 的 `duration`**；短了就加 `--cookies-from-browser edge` 重下（cookie 态走 DASH 音频流如 30280，拿全量）。

从 JSON 输出中映射字段：
   - **title**：`fulltitle` 或 `title`
   - **podcast**：`channel`，若无则 `uploader`（B站为 UP 主名）
   - **date**：`upload_date`（格式 `YYYYMMDD`，需转为 `YYYY-MM-DD`）
   - **duration**：`duration`（秒，需转为分钟）
   - **description**：`description`
   - **hosts**：`channel` / `uploader`（作为主播）
   - **guests**：从 description 或 title 中推断（如适用）
   - **chapters**：`chapters` 数组（如果视频有章节标记，每个 chapter 有 `start_time` 和 `title`）
   - **plays**：`view_count`
   - **language**：B站默认 `zh`；YouTube 需根据视频语言判断

**注意：**
- `b23.tv` 短链可直接交给 yt-dlp（自动跟随重定向）
- **B站简介常含参考文献列表**（理论型视频尤其如此），元数据阶段单独留意——后续可用来校正 Whisper 转写中的专名音译错误
- YouTube URL 可能包含时间戳参数（如 `?t=2s`），这是页面跳转时间，不影响音频下载和处理

3. 向用户展示提取到的信息，确认后继续

### Step 2: 获取 Transcript（优先平台字幕，回退 Whisper）

**核心策略：** 优先使用平台自带的带时间戳字幕（速度快、无幻觉），仅在字幕不可用或质量不足时回退到 Whisper 转写。

```
平台字幕可用？
  ├─ YES → 直接解析为 segments.json → 跳到 Step 3
  └─ NO  → 下载音频 → Whisper 转写 → 继续 Step 3
```

#### Step 2a: 尝试获取平台字幕

**yt-dlp 通道（YouTube / B站等）：**

```bash
# 创建临时工作目录
WORK_DIR=$(mktemp -d /tmp/podcast-digest.XXXXXX)
# 唯一命名：并发运行互不干扰（2026-08-27 并发踩踏事故：固定路径指针导致两任务互写对方的 segments.json）
# 后续步骤优先直接使用上下文中记住的 $WORK_DIR，指针文件仅作恢复用
echo "$WORK_DIR" > "/tmp/podcast-digest-workdir.$(basename "$WORK_DIR").txt"

# 下载平台自动生成的字幕（VTT 格式）
# SUB_LANG 按素材语言选择：英文视频用 en；中文视频用 "zh-Hans,zh-CN"（B站 AI 字幕常见代号还有 ai-zho）
yt-dlp --write-auto-subs --sub-langs "$SUB_LANG" --sub-format vtt --skip-download \
  --cookies-from-browser edge \
  -o "$WORK_DIR/subs" "MEDIA_URL"
```

- **YouTube**：自动字幕通常可用，质量较好
- **B站**：多数视频没有 CC 字幕（`--dump-json` 的 `subtitles`/`automatic_captions` 为空即无），直接走 Step 2b Whisper 路径
- 其他站点按情况尝试，失败不阻塞，回退 Whisper

**小宇宙：**
小宇宙目前不提供公开的字幕/transcript API，直接跳到 Step 2b（Whisper 路径）。

#### 字幕质量检查 & 解析

如果下载到 VTT 字幕文件，用脚本解析并检查质量：

```bash
python3 "$SKILL_DIR/scripts/parse_subtitles.py" "$WORK_DIR/subs.en.vtt" "$DURATION_SEC" "$WORK_DIR"
```

脚本功能：
- 解析 VTT 为带时间戳的 segments
- 质量检查（覆盖率 >= 80%，空段率 <= 5%）
- 按 30 分钟分段写入 `seg_XXX/segments.json`、`meta.json`、`transcript.txt`

**退出码 0 = 质量通过，直接跳到 Step 3**
**退出码 1 = 质量不足，继续执行 Step 2b（Whisper 回退）**

**如果质量检查失败或无字幕：** 继续执行 Step 2b。

#### Step 2b: 下载音频 & Whisper 转写（回退路径）

仅在平台字幕不可用时执行。

##### 小宇宙：用 curl 下载

```bash
WORK_DIR=${WORK_DIR:-$(ls -td /tmp/podcast-digest.*/ 2>/dev/null | head -1)}   # 用上下文中记住的目录；恢复时取最新的，严禁读固定路径指针

# 下载音频
curl -L -o "$WORK_DIR/audio.m4a" "$AUDIO_URL"

# 转为 16kHz mono WAV（whisper 输入格式）
ffmpeg -i "$WORK_DIR/audio.m4a" -ar 16000 -ac 1 -c:a pcm_s16le "$WORK_DIR/audio.wav" -y
```

##### yt-dlp 通道（YouTube / B站等）：下载音频

```bash
WORK_DIR=${WORK_DIR:-$(ls -td /tmp/podcast-digest.*/ 2>/dev/null | head -1)}   # 用上下文中记住的目录；恢复时取最新的，严禁读固定路径指针

# 用 yt-dlp 直接下载并转为最佳质量音频
yt-dlp -x --audio-format wav --audio-quality 0 --cookies-from-browser edge \
  --postprocessor-args "-ar 16000 -ac 1 -c:a pcm_s16le" \
  -o "$WORK_DIR/audio.%(ext)s" "MEDIA_URL"

# 确保转为 16kHz mono WAV
if [ ! -f "$WORK_DIR/audio.wav" ]; then
  ACTUAL=$(ls "$WORK_DIR"/audio.* 2>/dev/null | head -1)
  ffmpeg -i "$ACTUAL" -ar 16000 -ac 1 -c:a pcm_s16le "$WORK_DIR/audio.wav" -y
fi

# 铁律：核实音频时长 ≈ 元数据 duration，防静默截断
ffprobe -v error -show_entries format=duration -of csv=p=0 "$WORK_DIR/audio.wav"
```

##### 通用：--clip 截取和分段

```bash
# 如果指定了 --clip N，截取前 N 分钟
if [ -n "$CLIP_MINUTES" ]; then
  ffmpeg -i "$WORK_DIR/audio.wav" -t $((CLIP_MINUTES * 60)) -c copy "$WORK_DIR/clip.wav" -y
  mv "$WORK_DIR/clip.wav" "$WORK_DIR/audio.wav"
fi
```

**分段逻辑（超过 30 分钟的播客）：**

```bash
DURATION_SEC=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$WORK_DIR/audio.wav" | cut -d. -f1)
SEGMENT_SEC=1800  # 30 分钟

if [ "$DURATION_SEC" -gt "$SEGMENT_SEC" ]; then
  mkdir -p "$WORK_DIR/segments"
  ffmpeg -i "$WORK_DIR/audio.wav" -f segment -segment_time $SEGMENT_SEC -c copy "$WORK_DIR/segments/seg_%03d.wav" -y
else
  mkdir -p "$WORK_DIR/segments"
  cp "$WORK_DIR/audio.wav" "$WORK_DIR/segments/seg_000.wav"
fi
```

##### Whisper 转写

```bash
for seg_file in "$WORK_DIR"/segments/seg_*.wav; do
  seg_name=$(basename "$seg_file" .wav)
  echo "=== Transcribing $seg_name ==="
  # LANG_CODE 与 Step 1 判定的素材语言一致：中文传 zh，英文传 en
  bash "$SKILL_DIR/scripts/transcribe.sh" "$seg_file" "$WORK_DIR/$seg_name" "$LANG_CODE"
  echo "=== Done $seg_name ==="
done
```

##### Whisper 幻觉清理

Whisper 转写可能产生重复文本（幻觉）。用脚本清理：

```bash
python3 "$SKILL_DIR/scripts/clean_hallucination.py" "$WORK_DIR/seg_XXX/segments.json"
```

如果清理后覆盖率严重下降（< 60%），报告用户并建议使用平台字幕或手动检查。

#### 统一：生成 offset 和统计

无论是平台字幕还是 Whisper，最终都要为每段生成 `meta.json` 和统计信息：

```bash
# 为每个段生成 offset 文件
OFFSET=0
for seg_dir in $(ls -d "$WORK_DIR"/seg_* 2>/dev/null | sort); do
  echo "{\"offset\": $OFFSET}" > "$seg_dir/meta.json"
  END_TIME=$(python3 -c "
import json
with open('$seg_dir/segments.json') as f:
    segs = json.load(f)
print(segs[-1]['end'] if segs else 0)
" 2>/dev/null || echo 1800)
  OFFSET=$(echo "$OFFSET + $END_TIME" | bc)
done

# 统计
TOTAL_SEGMENTS=0
TOTAL_CHARS=0
for seg_dir in "$WORK_DIR"/seg_*; do
  SEG_COUNT=$(python3 -c "import json; print(len(json.load(open('$seg_dir/segments.json'))))" 2>/dev/null || echo 0)
  TOTAL_SEGMENTS=$((TOTAL_SEGMENTS + SEG_COUNT))
  TOTAL_CHARS=$((TOTAL_CHARS + $(wc -c < "$seg_dir/transcript.txt" 2>/dev/null || echo 0)))
done
echo "Transcript ready: $TOTAL_SEGMENTS segments, $TOTAL_CHARS chars"
```

向用户报告：`Transcript 就绪，共 N 段 segments，总字数 M 字符（来源：平台字幕 / Whisper）`

### Step 3: 分层生成结构化内容

**核心原则：Transcript 直接存储带时间戳的原始 segments（来自平台字幕或 Whisper），不经 LLM 处理。结构化内容按段落聚合生成。**

#### 3a. Transcript — 直接存储（无需处理）

Transcript 数据已经在 Step 2 中就绪：每个段目录下有 `segments.json`（精确时间戳）和 `meta.json`（offset 偏移量）。

**不需要任何 Python 脚本处理。** Step 5 组装 YAML 时直接读取这些文件写入 transcript 字段。

**数据格式：**
```yaml
transcript:
  - offset: 0        # 该段在完整音频中的起始秒数
    segments:
      - start: 0.0
        end: 2.5
        text: "Hello welcome to..."
      - start: 2.5
        end: 5.1
        text: "the podcast today..."
  - offset: 1800     # 第二段从 30:00 开始
    segments:
      - start: 0.0
        end: 3.2
        text: "..."
```

前端渲染时，实际时间 = `segment.start + offset`，可实现点击跳转到任意一句话。

#### 3b. 结构化内容 — 全文精读 + AI 作者化（取代旧"分段生成再精选"的拼装式）

**内容质量优先：token 不是 concern。** Summary / Highlights / Quotes / Takeaways 必须由 LLM 在**通读全部逐字稿**的基础上作者化产出，禁止用分段摘要拼装、禁止脚本/机械抽取。

**做法：** 把所有段的 transcript 按顺序合成全文（`cat "$WORK_DIR"/seg_*/transcript.txt > "$WORK_DIR/fulltext.txt"`，注意按段名排序），从头到尾精读一遍，然后一次性产出全局内容。40-60 分钟素材全文约 1.5-2.5 万字，直接读；2 小时以上素材也优先全文读，确实超长才允许"分段候选→精读合并"，且合并仍须回读原文核对。

**全局内容规格：**

- **Summary**：首句必须是能独立成立的导语（30-50 字：谁+做了什么+结果/核心主张）——很多渲染层会把首句抽成大字导语。其后按语义推进、句界干净（渲染层按句号自动分段，一逗到底的长句会毁掉排版）。中文素材只写 `summary`；英文素材写 `summary` + `summaryZh`
- **Key Highlights**：40-60 分钟素材 8-12 条（更长素材可到 15 条）。每条四件套：
  - `title`：小标签式短语（如"找对标表格：收入靠执行力验证"）
  - `thesis`：**一句话论点**，15-35 字，是 content 的蒸馏而非复述——优先借用讲者最锐利的原话（如「当他用了『干货』这两个字的时候，他讲的一切都不重要了」）。渲染层通常把它排版成编号卡片里的章首引文块
  - `content`：100-200 字忠实展开：论点的论据、案例、数字。**事实必须来自逐字稿，不脑补**
  - `time`："MM:SS"，该观点在音频中的位置
  - **洞见独立性**：两条不同的方法/洞见不要合并成一条（原型篇教训：抠字词和换词是两个独立方法，必须拆开各成一条）；反过来凑不满 8 条也不要硬凑
- **Key Quotes**：5-8 句原话，素材原语言、逐字准确（Whisper 错字先校正再引用），标 speaker + time
- **Actionable Takeaways**：5-7 条行动建议
- **Keywords & Topics**：8-10 个关键词，每个带一句话 description（**禁止空字符串**——没内容就删掉整个 entry）
- **Chapter Breakdown**：`chapters`（时间戳+标题）+ `chapterDetails`（每章 2-3 句解说）；素材无章节标记时按内容主题自行划分

**Whisper/字幕错字校正：** 精读时同步校正同音字错误，校正后的写法进入所有结构化字段（transcript 按惯例保留原样）。高频坑：小黄叔→小红书、黑客风→黑客松、一成设置→议程设置、拟据理论→拟剧理论、看错能力→扛错能力、变线→变现、玩播率→完播率。专名以 Step 1 元数据里的简介/参考文献为准。

**语言方向（不变）：** 中文素材纯中文、不产出任何 `*Zh` 字段；英文素材双语（`title/thesis/content` + `*Zh` 成对）；Quotes 保留素材原语言。

#### 3c. Transcript 翻译（仅英文素材，分段处理）

对英文素材的每段 segments 进行中文翻译。逐段处理（和 3b 相同的 30 分钟分段），避免一次性处理太长内容。中文素材跳过本步。

**处理方式：**
- 读取每段的 `transcript.txt`
- LLM 逐句翻译为中文，保持与原文的对应关系
- 翻译结果写入每段的 `segments.json`，为每个 segment 添加 `translation` 字段

```bash
# 示例：翻译后 segments.json 中每条变为
{"start": 0.0, "end": 3.12, "text": "I think it is very hard...", "translation": "我认为很难做到..."}
```

**翻译原则：**
- 口语化翻译，符合中文播客的语感
- 保留原文的语气和情感（幽默、激动、强调等）
- 专有名词保持英文（Claude Code, Anthropic 等）
- **严格逐段 1:1，段中断句保留悬垂部分**：禁止把后段内容并入前段换取流畅——2026-08-27 skill-eval 实测，跨段吸收会导致时间戳错位 + 末段漏译，且漏译会静默传导进 summary/quotes
- **收尾自查末段翻译完整性**：末段/被切断的段落是截断高发区（同次 eval 实测截断 60% 仍能骗过"非空"检查；`scripts/validate-episode.mjs` 已加中英比值启发式告警）
- 每段翻译完成后写入该段的 `segments.json`，Step 5 组装时自动包含

### Step 4: 输出结构化 Markdown

按以下 frontmatter 格式生成文件（不再是 markdown body，全部存为 frontmatter 字段）：

```yaml
---
title: "{title}"
podcast: "{podcast}"
date: "{date}"
duration: "{duration}"
language: zh
source: "{source_url}"
hosts:
  - {host1}
guests:
  - {guest1}
keywords: [{keyword1}, {keyword2}, ...]
plays: {plays}
chapters:
  - time: "00:59"
    title: "章节标题"
  - time: "07:38"
    title: "章节标题"
summary: "{English summary}"
summaryZh: "{中文摘要}"
highlights:
  - title: "English title"
    titleZh: "中文标题"
    thesis: "一句话论点（15-35字，讲者最锐利的原话优先）"
    thesisZh: "仅英文素材"
    content: "English content"
    contentZh: "中文内容"
    time: "MM:SS"
quotes:
  - speaker: "Speaker name"
    text: "English quote"
    textZh: "中文翻译"
    time: "MM:SS"
takeaways:
  - title: "English title"
    titleZh: "中文标题"
    content: "English content"
    contentZh: "中文内容"
    time: "MM:SS"
topics:
  - keyword: "English keyword"
    keywordZh: "中文关键词"
    description: "English description"
    descriptionZh: "中文解释"
chapterDetails:
  - time: "00:59"
    title: "English title"
    titleZh: "中文标题"
    content: "English content"
    contentZh: "中文内容"
transcript:
  - offset: 0
    segments:
      - start: 0.0
        end: 2.5
        text: "第一句话..."
      - start: 2.5
        end: 5.1
        text: "第二句话..."
  - offset: 1800
    segments:
      - start: 0.0
        end: 3.2
        text: "..."
---
```

**组装方式：** 读取每个段目录（`seg_000/`, `seg_001/`, ...）下的 `meta.json`（获取 offset）和 `segments.json`（获取 segments 数组），按顺序写入 transcript 数组。不需要 Python，直接用 bash 逐段拼接即可。

**YAML 安全规则（踩坑记录）：**
- **`date` 必须用引号包裹**（如 `date: "2026-04-23"`），否则 YAML 会将其解析为 Date 对象，导致下游 schema 校验失败
- **可选字段如果没有值，直接省略，不要写 `null`**（如 `comments`、`guests`）——很多下游 schema（如 Zod）对 optional number 字段不接受 `null`
- **每个数组必须有键行且字段非空**：`transcript:`/`chapterDetails:` 等键行漏写，数组的 entry 会被 YAML 静默吞进前一个 key（2026-10-06 事故：漏 `transcript:` 键行，transcript chunks 全部并进 chapterDetails，直到 build 时才炸）；`description: ''` 这类空值同样过不了校验（validate-episode.mjs 规则10 专抓这两类）
- **`---` 结尾标记必须独占一行**，不能粘在 transcript 内容末尾。组装文件时确保最后一行后有换行，再写 `---`
- 如果文本中有特殊字符（冒号后跟空格、# 号等），需要用引号包裹该字段

**输出路径：** 默认写到当前工作目录的 `./episodes/` 下（不存在则创建），或用户指定的目录
**文件名：** `{date}-{slug}.md`，slug 为标题的简短英文或拼音

**（可选）归档一份自包含笔记到个人知识库：** 在你的笔记库（Obsidian / Notion / 任意 Markdown 库）按主题归档时，写一份**自包含可读笔记**：标题、来源 URL、摘要、highlights/quotes/takeaways/topics、参考文献（如有），**外加段落版逐字稿**——把分段 segments 合并成段落（约 200 字/段，Whisper 输出无标点故按累计字数切分），有章节元数据时在对应位置插入 `### {time} {章节名}` 小节标题。精确时间戳的逐字稿只在 episode 文件的 transcript 字段保存（支持点击跳转），笔记库不重复存碎片版。

### Step 5: 报告

向用户报告：
1. 音频时长和分段数
2. 转写总字数
3. 生成的结构化内容统计（N 个亮点、N 条金句等）
4. 输出文件路径

**收尾硬校验（必做）：** 组装完 episode 文件后，运行本 skill 自带的校验脚本，错误清零才算完成（YAML 安全规则已全部固化进该脚本，不靠记忆；首次使用前先在本 skill 目录 `npm install` 安装 js-yaml）：

```bash
cd "$SKILL_DIR" && node scripts/validate-episode.mjs <本次输出的 episode.md>
```

脚本覆盖：date 引号、null 值、chapters 多余键、offset 时间数学（绝对时间戳+非零 offset 会直接判错）、en 素材 translation 1:1 完整性、frontmatter 边界。建议把它挂进你的内容仓库的 pre-commit hook 自动触发。

## 注意事项

- **内容质量优先：token 不是 concern。** 结构化内容必须按 3b 由 LLM 精读全文后作者化产出；分段管线只是为了转写和翻译，不构成"用分段摘要拼全局"的理由
- **平台字幕优先**：YouTube 等平台自带字幕质量通常优于 Whisper，且无幻觉问题，应优先使用
- **yt-dlp 时效性**：B站等站点风控变化快，系统安装的 yt-dlp 报 412/403 时，下载 GitHub standalone 最新版重试（2026-08 实测：2026.03 版被 B站拒绝，2026.07 版正常，无需 cookie）
- **B站充电专属/大会员视频**：加 `--cookies-from-browser edge` 带上用户浏览器里的登录态即可访问（无 cookie 只能拿到几分钟试看流）
- **视频归档（可选）**：值得长期保留的素材，可下载**视频版本 mp4**（含音轨）存到自己的归档目录 `<ARCHIVE_DIR>/video/`，命名 `{date}-{标题}-{频道名}.mp4`。B站视频音流分离，需选择+合并：`yt-dlp --cookies-from-browser edge -f "bv*[vcodec^=avc1][height<=1080]+ba[ext=m4a]/bv*+ba/b" --merge-output-format mp4 -o "<目标路径>.%(ext)s" <URL>`（转写用的音频仍走 `-x` 音频管线，两者互不影响）
- **B站简介常含参考文献列表**：理论型视频尤其如此，是校正 Whisper 专名音译的好材料
- **语言方向**：中文素材（小宇宙、B站）纯中文输出、无 `*Zh` 字段；英文素材双语输出。Whisper 转写语言参数与素材语言一致（`zh`/`en`），字幕 `--sub-langs` 同理
- **Whisper 作为回退**：仅在平台字幕不可用或质量不足时使用 Whisper 转写
- **Whisper 幻觉**：Whisper 转写可能产生大量重复文本（幻觉），必须用 `clean_hallucination.py` 清理
- 音频文件可能很大（200MB+），下载需要时间
- Whisper 转写耗时取决于音频长度（whisper-cli + Metal 约 1-3x 实时）
- **分段处理**解决了长播客的 context window 限制，理论上可处理任意长度
- 如果小宇宙页面无法获取音频 URL，提示用户手动下载音频文件并提供本地路径
- **语言检测**：根据播客内容决定 `language` 字段（`zh` 或 `en`），小宇宙/B站默认 `zh`，YouTube 需根据视频语言判断
- 每段 30 分钟 ≈ 6000-8000 字中文转写，在 LLM context window 内可以舒适处理
- yt-dlp 通道（YouTube/B站等）音频下载依赖 `yt-dlp`（需已安装），支持 `youtube.com`、`youtu.be`、`bilibili.com`、`b23.tv` 等链接
- YouTube 可能需要 cookie 认证（`--cookies-from-browser edge`），Chrome/Safari 也可尝试
- 视频画面不参与处理，仅提取音频轨道
- URL 中的时间戳参数（如 `?t=2s`）不影响音频下载和转写

## 脚本目录

| 脚本 | 用途 |
|------|------|
| `scripts/transcribe.sh` | Whisper 转写（音频 → segments.json），自动选 whisper.cpp (Metal) 或 Python whisper |
| `scripts/parse_subtitles.py` | 解析平台字幕（VTT → segments.json）+ 质量检查 + 分段 |
| `scripts/clean_hallucination.py` | 清理 Whisper 幻觉（移除重复段） |
| `scripts/validate-episode.mjs` | 输出硬校验（YAML 安全规则 + 双语契约 + offset 时间数学） |
