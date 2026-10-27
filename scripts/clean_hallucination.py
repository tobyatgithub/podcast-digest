#!/usr/bin/env python3
"""
clean_hallucination.py — 清理 Whisper 转写中的重复幻觉段

用法:
  python3 clean_hallucination.py <segments.json>

功能:
  移除连续重复的 segments（Whisper 幻觉特征）
  保留清理后的数据，报告覆盖率变化

注意:
  直接修改输入文件（in-place），请提前备份
"""

import json
import sys
import os


def clean_hallucination(segments):
    """移除连续 3+ 段完全相同文本的幻觉"""
    clean = []
    for i, seg in enumerate(segments):
        text = seg['text'].strip()
        if i >= 2 and text == segments[i-1]['text'].strip() == segments[i-2]['text'].strip():
            continue
        clean.append(seg)
    return clean


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <segments.json>", file=sys.stderr)
        sys.exit(1)

    path = sys.argv[1]
    with open(path) as f:
        segments = json.load(f)

    original_count = len(segments)
    original_end = segments[-1]['end'] if segments else 0

    cleaned = clean_hallucination(segments)

    cleaned_count = len(cleaned)
    cleaned_end = cleaned[-1]['end'] if cleaned else 0
    removed = original_count - cleaned_count

    with open(path, 'w') as f:
        json.dump(cleaned, f, ensure_ascii=False, indent=2)

    coverage_ratio = cleaned_end / original_end if original_end > 0 else 0
    print(f"Cleaned: {original_count} -> {cleaned_count} segments ({removed} removed)")
    print(f"Coverage: {cleaned_end:.1f}s / {original_end:.1f}s ({coverage_ratio:.1%})")

    if coverage_ratio < 0.6:
        print(f"WARNING: Coverage dropped below 60%. Consider using platform subtitles instead.",
              file=sys.stderr)


if __name__ == '__main__':
    main()
