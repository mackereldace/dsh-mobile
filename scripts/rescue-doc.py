#!/usr/bin/env python3
"""抢救被"追加失控"写爆的 05 文档（第二版：按章节去重，不截断）。

第一版用"遇到重复就停" ✗ —— 结果只留下 1 个章节 ✓：
说明失控不是"整份重复" ✗，而是**在中间交错重复** ✓
（例如 §1..§5 → §5 重复很多次 → §6.. 等等 ✓）。

这一版：**保留每个 `## N.` 章节的第一次出现** ✓，跳过之后重复出现的那些 ✓
（流式处理 ✓，9.3 GB 也吃得下 ✓）。
"""
import io
import re
import sys

src = sys.argv[1] if len(sys.argv) > 1 else '05-项目进度与改动评估.md'
dst = sys.argv[2] if len(sys.argv) > 2 else '/tmp/05-clean2.md'

seen = set()
skipping = False
kept = 0
with io.open(src, encoding='utf8', errors='replace') as handle:
    with io.open(dst, 'w', encoding='utf8') as out:
        for line in handle:
            match = re.match(r'^## (\d+)\.', line)
            if match is not None:
                number = match.group(1)
                if number in seen:
                    skipping = True
                else:
                    seen.add(number)
                    skipping = False
            if not skipping:
                out.write(line)
                kept += 1

print(f'保留章节 {len(seen)} 个，行数 {kept}，写入 {dst}')
print('章节：', sorted(seen, key=int))
