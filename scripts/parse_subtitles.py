#!/usr/bin/env python3
"""
parse_subtitles.py — 解析平台字幕（VTT）为 segments.json 格式

用法:
  python3 parse_subtitles.py <vtt_file> <audio_duration_sec> <output_dir> [--segment-size 1800]

功能:
  1. 解析 VTT 字幕为 segments 数组（带时间戳）
  2. 质量检查（覆盖率、空段率）
  3. 按 segment-size（默认 30 分钟）拆分为 seg_XXX/segments.json + meta.json
  4. 生成 transcript.txt

输出:
  <output_dir>/seg_000/segments.json
  <output_dir>/seg_000/transcript.txt
  <output_dir>/seg_000/meta.json
  <output_dir>/seg_001/segments.json  (如果超过 30 分钟)
  ...

退出码:
  0 — 字幕质量合格，已写入 segments
  1 — 字幕质量不合格（输出原因到 stderr）
"""

import json
import re
import sys
import os


def parse_vtt(vtt_path):
    """
    Parse YouTube auto-generated VTT subtitles.

    YouTube auto-generated VTT uses a specific pattern:
    - Content segment (2-5s): "word1 word2 word3 word4 word5 word6" (old + new)
    - Echo segment (~0.01s): "word3 word4 word5 word6" (just the new display line)

    The echo segments contain the CLEAN, deduplicated text — just the current
    line being displayed, without overlap from the previous line.

    Strategy: Use echo segments for text (already clean), and the preceding
    content segment's start time for timing.
    """
    with open(vtt_path, 'r', encoding='utf-8') as f:
        content = f.read()

    all_raw = []
    pattern = r'(\d+:\d+:\d+\.\d+)\s*-->\s*(\d+:\d+:\d+\.\d+).*?\n(.+?)(?=\n\n|\n$)'
    matches = re.findall(pattern, content, re.DOTALL)

    for start, end, text in matches:
        def to_sec(t):
            parts = t.replace(',', '.').split(':')
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])

        text = re.sub(r'<[^>]+>', '', text.strip().replace('\n', ' '))
        duration = to_sec(end) - to_sec(start)
        if text:
            all_raw.append({
                'start': round(to_sec(start), 2),
                'end': round(to_sec(end), 2),
                'text': text,
                'is_echo': duration < 0.05
            })

    if not all_raw:
        return []

    # Strategy: echo segments have clean text, content segments have good timing.
    # Pair each echo with the preceding content segment's start time.
    cleaned = []
    prev_content_start = None

    for i, seg in enumerate(all_raw):
        if seg['is_echo']:
            # Echo = clean text, use preceding content segment's start time
            start = prev_content_start if prev_content_start is not None else seg['start']
            cleaned.append({
                'start': round(start, 2),
                'end': seg['start'],  # echo time ≈ end of display period
                'text': seg['text']
            })
        else:
            prev_content_start = seg['start']

    # If no echoes found (non-YouTube VTT), fall back to simple content extraction
    if not cleaned:
        cleaned = [{'start': s['start'], 'end': s['end'], 'text': s['text']}
                    for s in all_raw if not s['is_echo']]

    # Merge short fragments into sentence-level segments (~8-15 seconds).
    # YouTube echo segments are ~2s each, which is too granular.
    # Merge until we hit a sentence boundary or a reasonable duration.
    merged = []
    buf_text = ""
    buf_start = 0.0
    buf_end = 0.0

    # Sentence-ending punctuation
    sent_end = re.compile(r'[.!?][\"\'”’]?\s*$')

    for seg in cleaned:
        if not buf_text:
            buf_start = seg['start']
            buf_text = seg['text']
        else:
            buf_text += " " + seg['text']

        buf_end = seg['end']
        seg_duration = buf_end - buf_start

        # Flush the buffer when:
        # 1. We hit a sentence boundary AND duration >= 5s (natural sentence break)
        # 2. Duration >= 15s (cap segment length)
        if (sent_end.search(buf_text) and seg_duration >= 5.0) or seg_duration >= 15.0:
            merged.append({
                'start': round(buf_start, 2),
                'end': round(buf_end, 2),
                'text': buf_text.strip()
            })
            buf_text = ""

    # Flush remaining buffer
    if buf_text.strip():
        merged.append({
            'start': round(buf_start, 2),
            'end': round(buf_end, 2),
            'text': buf_text.strip()
        })

    return merged


def check_quality(segments, audio_duration_sec):
    if len(segments) == 0:
        return False, "no segments"

    coverage = segments[-1]['end'] / audio_duration_sec
    if coverage < 0.8:
        return False, f"coverage too low: {coverage:.1%} (need >= 80%)"

    empty_ratio = sum(1 for s in segments if len(s['text'].strip()) < 2) / len(segments)
    if empty_ratio > 0.05:
        return False, f"too many empty segments: {empty_ratio:.1%} (need <= 5%)"

    return True, "ok"


def split_into_segment_dirs(segments, output_dir, segment_size=1800):
    os.makedirs(output_dir, exist_ok=True)

    seg_idx = 0
    offset = 0
    i = 0

    while i < len(segments):
        seg_dir = os.path.join(output_dir, f"seg_{seg_idx:03d}")
        os.makedirs(seg_dir, exist_ok=True)

        cutoff = offset + segment_size
        chunk = []
        while i < len(segments) and segments[i]['start'] < cutoff:
            chunk.append(segments[i])
            i += 1

        if not chunk:
            break

        # Write segments.json
        with open(os.path.join(seg_dir, 'segments.json'), 'w') as f:
            json.dump(chunk, f, ensure_ascii=False, indent=2)

        # Write transcript.txt
        with open(os.path.join(seg_dir, 'transcript.txt'), 'w') as f:
            for j, s in enumerate(chunk):
                f.write(f"{j+1}\t{s['text']}\n")

        # Write meta.json
        with open(os.path.join(seg_dir, 'meta.json'), 'w') as f:
            json.dump({"offset": offset}, f)

        offset = cutoff
        seg_idx += 1

    return seg_idx  # number of segments created


def main():
    if len(sys.argv) < 4:
        print(f"Usage: {sys.argv[0]} <vtt_file> <audio_duration_sec> <output_dir> [--segment-size 1800]",
              file=sys.stderr)
        sys.exit(1)

    vtt_path = sys.argv[1]
    audio_duration = float(sys.argv[2])
    output_dir = sys.argv[3]
    segment_size = 1800

    if '--segment-size' in sys.argv:
        idx = sys.argv.index('--segment-size')
        segment_size = int(sys.argv[idx + 1])

    if not os.path.exists(vtt_path):
        print(f"ERROR: VTT file not found: {vtt_path}", file=sys.stderr)
        sys.exit(1)

    # Parse
    segments = parse_vtt(vtt_path)
    print(f"Parsed {len(segments)} segments from VTT")

    # Quality check
    passed, reason = check_quality(segments, audio_duration)
    if not passed:
        print(f"QUALITY CHECK FAILED: {reason}", file=sys.stderr)
        sys.exit(1)

    print(f"Quality check passed: coverage={segments[-1]['end']/audio_duration:.1%}, segments={len(segments)}")

    # Split and write
    num_segs = split_into_segment_dirs(segments, output_dir, segment_size)
    print(f"Written {num_segs} segment dirs to {output_dir}")

    # Stats
    total_words = sum(len(s['text'].split()) for s in segments)
    print(f"Total: {len(segments)} segments, ~{total_words} words")


if __name__ == '__main__':
    main()
