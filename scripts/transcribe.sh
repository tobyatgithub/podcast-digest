#!/bin/bash
# transcribe.sh — Whisper 转写脚本
# 用法: transcribe.sh <input.wav> <output_dir> [language]
#
# 自动检测最佳转写引擎：
#   1. whisper-cli (whisper.cpp) + Metal GPU — 最快
#   2. Python whisper (conda py310) — fallback
#
# 输出:
#   <output_dir>/transcript.txt  — 完整转录文本
#   <output_dir>/segments.json   — 带时间戳的分段 JSON

set -euo pipefail

INPUT_WAV="$1"
OUTPUT_DIR="$2"
LANGUAGE="${3:-zh}"
MODEL_DIR="$HOME/.cache/podcast-digest/models"
MODEL_NAME="ggml-large-v3.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}"

# Python 解析器：优先装了 openai-whisper 的 conda py310，回退系统 python3
if [ -x /opt/homebrew/anaconda3/envs/py310/bin/python ]; then
  PYTHON_BIN="/opt/homebrew/anaconda3/envs/py310/bin/python"
else
  PYTHON_BIN="$(command -v python3)"
fi

mkdir -p "$OUTPUT_DIR"
mkdir -p "$MODEL_DIR"

# --- 检查输入文件 ---
if [ ! -f "$INPUT_WAV" ]; then
  echo "ERROR: Input file not found: $INPUT_WAV" >&2
  exit 1
fi

# --- 函数：下载 ggml 模型 ---
download_model() {
  if [ ! -f "$MODEL_DIR/$MODEL_NAME" ]; then
    echo "Downloading $MODEL_NAME (this may take a few minutes)..." >&2
    curl -L -o "$MODEL_DIR/$MODEL_NAME" "$MODEL_URL"
    echo "Model downloaded." >&2
  fi
}

# --- 函数：whisper-cli 转写 ---
transcribe_whisper_cli() {
  local model_path="$MODEL_DIR/$MODEL_NAME"
  echo "Using whisper-cli (Metal GPU accelerated)" >&2

  whisper-cli \
    -m "$model_path" \
    -l "$LANGUAGE" \
    -f "$INPUT_WAV" \
    -otxt "$OUTPUT_DIR/transcript_raw.txt" \
    -ovtt "$OUTPUT_DIR/subtitles.vtt" \
    --no-timestamps \
    2>&1

  # whisper-cli outputs to <input>.wav.txt, need to handle the naming
  # Actually it outputs alongside the input file or with specific flags
  # Let's use a different approach: capture output directly
}

# --- 函数：whisper-cli 转写 (v2, 直接输出) ---
transcribe_whisper_cli_v2() {
  local model_path="$MODEL_DIR/$MODEL_NAME"
  echo "Using whisper-cli (Metal GPU accelerated)" >&2

  # Generate SRT for timestamps + plain text for transcript
  whisper-cli \
    -m "$model_path" \
    -l "$LANGUAGE" \
    -f "$INPUT_WAV" \
    --output-srt \
    2>/dev/null > "$OUTPUT_DIR/output.srt"

  # Extract plain text from SRT
  grep -v '^[0-9]*$' "$OUTPUT_DIR/output.srt" | \
    grep -v '^[0-9][0-9]:[0-9][0-9]:[0-9][0-9]' | \
    grep -v '^$' | \
    grep -v '\-\->' \
    > "$OUTPUT_DIR/transcript.txt"

  echo "whisper-cli transcription complete." >&2
}

# --- 函数：Python whisper 转写 ---
transcribe_python() {
  echo "Using Python whisper ($PYTHON_BIN)" >&2

  if ! "$PYTHON_BIN" -c "import whisper" 2>/dev/null; then
    echo "ERROR: openai-whisper not available in $PYTHON_BIN" >&2
    exit 1
  fi

  "$PYTHON_BIN" -c "
import whisper, json, sys

input_wav = sys.argv[1]
output_dir = sys.argv[2]
language = sys.argv[3]

print('Loading whisper model...', file=sys.stderr)
model = whisper.load_model('large-v3')

print('Starting transcription...', file=sys.stderr)
result = model.transcribe(input_wav, language=language, verbose=False)

# Save plain text
with open(f'{output_dir}/transcript.txt', 'w') as f:
    f.write(result['text'])

# Save segments JSON
segments = []
for seg in result['segments']:
    segments.append({
        'start': seg['start'],
        'end': seg['end'],
        'text': seg['text'].strip()
    })
with open(f'{output_dir}/segments.json', 'w') as f:
    json.dump(segments, f, ensure_ascii=False, indent=2)

print(f'Transcription complete. {len(segments)} segments, {len(result[\"text\"])} chars.', file=sys.stderr)
" "$INPUT_WAV" "$OUTPUT_DIR" "$LANGUAGE"
}

# --- 主逻辑 ---
echo "=== Podcast Digest Transcription ===" >&2
echo "Input: $INPUT_WAV" >&2
echo "Output: $OUTPUT_DIR" >&2
echo "Language: $LANGUAGE" >&2
echo "" >&2

if command -v whisper-cli &>/dev/null; then
  echo "Found whisper-cli" >&2
  download_model

  # Use whisper-cli
  # Note: whisper-cli outputs to stdout in SRT format with --output-srt
  # We need to handle this carefully
  echo "Running whisper-cli..." >&2

  # Run whisper-cli and capture SRT output
  whisper-cli \
    -m "$MODEL_DIR/$MODEL_NAME" \
    -l "$LANGUAGE" \
    -f "$INPUT_WAV" \
    -t 8 \
    --split-on-word \
    2>/dev/null \
    > "$OUTPUT_DIR/output.srt"

  # Convert SRT to transcript.txt and segments.json
  "$PYTHON_BIN" -c "
import json, re, sys

srt_path = sys.argv[1]
output_dir = sys.argv[2]

with open(srt_path, 'r') as f:
    srt_content = f.read()

segments = []
texts = []

# Try bracket format first: [HH:MM:SS.mmm --> HH:MM:SS.mmm]  text
bracket_pattern = re.compile(r'\[(\d+):(\d+):(\d+)[.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[.](\d+)\]\s*(.*)')
# Standard SRT format: HH:MM:SS,mmm --> HH:MM:SS,mmm (on its own line)
srt_ts_pattern = re.compile(r'(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)')

has_bracket = bool(bracket_pattern.search(srt_content))

if has_bracket:
    # Bracket format: each line is a segment
    for line in srt_content.strip().split('\n'):
        line = line.strip()
        m = bracket_pattern.match(line)
        if m:
            g = m.groups()
            start = int(g[0])*3600 + int(g[1])*60 + int(g[2]) + int(g[3])/1000
            end = int(g[4])*3600 + int(g[5])*60 + int(g[6]) + int(g[7])/1000
            text = g[8].strip()
            if text:
                segments.append({'start': start, 'end': end, 'text': text})
                texts.append(text)
else:
    # Standard SRT format: numbered blocks
    blocks = re.split(r'\n\n+', srt_content.strip())
    for block in blocks:
        lines = block.strip().split('\n')
        if len(lines) >= 2:
            for i, line in enumerate(lines):
                ts_match = srt_ts_pattern.match(line)
                if ts_match:
                    g = ts_match.groups()
                    start = int(g[0])*3600 + int(g[1])*60 + int(g[2]) + int(g[3])/1000
                    end = int(g[4])*3600 + int(g[5])*60 + int(g[6]) + int(g[7])/1000
                    text = ' '.join(lines[i+1:]).strip()
                    if text:
                        segments.append({'start': start, 'end': end, 'text': text})
                        texts.append(text)
                    break

# Save transcript
with open(f'{output_dir}/transcript.txt', 'w') as f:
    f.write(''.join(texts))

# Save segments
with open(f'{output_dir}/segments.json', 'w') as f:
    json.dump(segments, f, ensure_ascii=False, indent=2)

print(f'Parsed {len(segments)} segments from SRT', file=sys.stderr)
" "$OUTPUT_DIR/output.srt" "$OUTPUT_DIR"

  echo "whisper-cli transcription complete." >&2

elif "$PYTHON_BIN" -c "import whisper" 2>/dev/null; then
  echo "whisper-cli not found, falling back to Python whisper" >&2
  transcribe_python
else
  echo "ERROR: No whisper engine available. Install whisper-cpp or openai-whisper." >&2
  exit 1
fi

# --- 验证输出 ---
if [ -f "$OUTPUT_DIR/transcript.txt" ] && [ -f "$OUTPUT_DIR/segments.json" ]; then
  CHAR_COUNT=$(wc -c < "$OUTPUT_DIR/transcript.txt")
  SEG_COUNT=$("$PYTHON_BIN" -c "import json; print(len(json.load(open('$OUTPUT_DIR/segments.json'))))")
  echo "" >&2
  echo "=== Transcription Complete ===" >&2
  echo "Segments: $SEG_COUNT" >&2
  echo "Characters: $CHAR_COUNT" >&2
else
  echo "ERROR: Transcription output files not found" >&2
  exit 1
fi
