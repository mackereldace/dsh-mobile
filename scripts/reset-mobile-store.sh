#!/usr/bin/env bash
# 清空 dsh-mobile 的设备库与审计流水，**保留主机身份**。
#
# ## 用途
#
# 联调期间会积累测试设备（名字类似 live-verify / e2e / 某方案手机）。
# 它们会让配对页一打开就显示陌生设备、"已配对"状态也不干净，干扰真机验收。
#
# ## 为什么必须停机执行
#
# `DeviceStore` 只在构造时 `load()` 一次，之后把记录**缓存在内存**，
# 任何写入都会用内存内容覆盖文件。所以运行中清空是无效的：
# 下一次写入就会把旧设备写回来。
# 本脚本因此在检测到 DSH 仍在运行时**直接拒绝**，而不是假装成功。
#
# ## 明确不动的东西
#
# `host-identity.json` 是**这台电脑的身份**（指纹来源）。
# 删掉它会让主机指纹改变，所有已配对手机全部失效，审计也会失去连续性。
# 它不参与"清理测试设备"，所以这里绝不碰。
#
# 用法：
#   bash scripts/reset-mobile-store.sh                  # 默认 ~/.dsh
#   DSH_HOME=/tmp/xxx bash scripts/reset-mobile-store.sh
#   FORCE=1 bash scripts/reset-mobile-store.sh          # 跳过"DSH 是否在运行"检查（慎用）

set -euo pipefail

# 与 resolve-dsh.mjs 保持一致：默认跟随 $DSH_HOME，否则 ~/.dsh
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DIR="$DSH_HOME/storages/dsh-mobile"

if [ ! -d "$DIR" ]; then
  echo "[reset-mobile-store] 目录不存在，无需清理：$DIR"
  exit 0
fi

if [ "${FORCE:-0}" != "1" ]; then
  # 只对**目标实例**探活：从该 home 的 profile 里读它实际监听的端口。
  # 不用固定 3080——那会把"另一个 home 的实例在跑"误判成"本实例在跑"，
  # 从而在安全的场景下无谓地拒绝（本项目真踩过这个误判）。
  TARGET_PORT="$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$DSH_HOME/profiles/web/cordis.yml" 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"
  if [ -z "$TARGET_PORT" ] && [ "$DSH_HOME" = "$HOME/.dsh" ]; then
    # 默认 home 且读不到端口时，按 DSH 的默认端口保守判断，宁可不做也不要清错
    TARGET_PORT="${DSH_PORT:-3080}"
  fi
  if [ -z "$TARGET_PORT" ]; then
    echo "[reset-mobile-store] 未在该 home 的 profile 中读到监听端口，跳过运行检测（临时 home 场景）"
  elif curl -s -m 2 -o /dev/null "http://127.0.0.1:${TARGET_PORT}/" 2>/dev/null; then
    cat >&2 <<EOF
[reset-mobile-store] 拒绝执行：检测到 127.0.0.1:${TARGET_PORT} 上仍有 DSH 在运行。

原因：运行中的实例把设备库缓存在内存里，之后任何写入都会用内存内容覆盖文件，
所以现在清空是无效的（旧设备会"复活"）。

请先停止 DSH，再执行本脚本；或在重启脚本里把它排在启动之前。
确实要强行清空（例如实例已僵死但端口还被占）：FORCE=1 bash scripts/reset-mobile-store.sh
（若该端口其实是别的进程占用，用 FORCE=1 跳过检查。）
EOF
    exit 1
  fi
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
for file in devices.json audit.json; do
  [ -f "$DIR/$file" ] && cp "$DIR/$file" "$DIR/$file.bak-$STAMP"
done

# 两个文件的顶层结构不同，必须分别按真实形状写：
#   devices.json → { version: 1, devices: [...] }
#   audit.json   → [ ... ]（纯数组）
printf '{\n  "version": 1,\n  "devices": []\n}\n' > "$DIR/devices.json"
printf '[]\n' > "$DIR/audit.json"

# 注意：变量后面紧跟全角字符（如中文括号）时必须用 ${VAR} 形式。
# bash 会把多字节字符的字节当作变量名的一部分，裸写 $STAMP） 会报
# "STAMP<乱码>: unbound variable"——本项目踩过（`set -u` 下直接中断）。
echo "[reset-mobile-store] 已清空设备库与审计（备份后缀 .bak-${STAMP}）"
echo "[reset-mobile-store] host-identity.json 未改动，主机指纹保持不变"
echo "[reset-mobile-store] 目录：$DIR"
