#!/usr/bin/env bash
# 启动"手机可访问"的 DSH：DSH 绑 loopback + 本机局域网代理 + 受信 authority。
#
# 为什么要三步而不是一条 --host 0.0.0.0：
#   DSH 刻意禁用 0.0.0.0 绑定（那会把 agent 的 bash/文件写能力直接暴露到网络）。
#   因此局域网访问走本机 TCP 代理，并让 DSH 显式信任代理后的 authority。
#
# 用法：
#   bash scripts/start-lan.sh                 # 自动探测局域网 IP，DSH 3080 / 代理 3081
#   RESTART=1 bash scripts/start-lan.sh       # 自动优雅停掉当前的 dsh 实例再启动
#   DSH_PORT=3080 PROXY_PORT=3081 bash scripts/start-lan.sh
#   LAN_IP=10.0.0.5 bash scripts/start-lan.sh
#   DSH_BIN=/path/to/dsh bash scripts/start-lan.sh   # 覆盖 dsh 入口（默认用全局安装）
# 停止：Ctrl-C（会一并停掉代理）
#
# dsh 入口由 scripts/resolve-dsh.mjs 解析（PATH → npm 全局前缀 → 常见默认目录），
# 与 live-verify.ts 共用同一份逻辑；不再扫描 npx 缓存（多版本共存会导致"改了没生效"）。
set -euo pipefail

DSH_PORT="${DSH_PORT:-3080}"
PROXY_PORT="${PROXY_PORT:-3081}"
# 手机侧必须走 HTTPS：普通 HTTP 页面不是安全上下文，crypto.subtle 不存在（实测见 docs/protocol.md §12.20）
TLS_PORT="${TLS_PORT:-3443}"
LAN_IP="${LAN_IP:-}"
DSH_BIN="${DSH_BIN:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 解析 dsh 可执行文件 ─────────────────────────────────────────────
# 委托给 scripts/resolve-dsh.mjs：**同一份解析逻辑**同时服务本脚本与 live-verify.ts。
#
# 为什么不再在这里自己找（并已移除 npx 缓存扫描）：本项目已改用**全局安装**，
# 而 npx 缓存里可能同时躺着多个版本——解析到旧版本的表现是"改了代码却没生效"，
# 这类静默错误比"找不到 dsh"难排查得多。解析顺序与理由见 resolve-dsh.mjs 的注释。
resolve_dsh() {
  if command -v node >/dev/null 2>&1; then
    node -e "
      import('${SCRIPT_DIR}/resolve-dsh.mjs')
        .then((module) => {
          const found = module.resolveDsh()
          if (found !== undefined) process.stdout.write(found)
        })
        .catch(() => {})
    " 2>/dev/null || true
    return 0
  fi
  # 连 node 都没有时（几乎不可能，因为 dsh 本身要 node）：退回 PATH 查找
  command -v dsh 2>/dev/null || true
}

if [ -z "$DSH_BIN" ]; then
  DSH_BIN="$(resolve_dsh || true)"
fi

if [ -z "$DSH_BIN" ] || [ ! -e "$DSH_BIN" ]; then
  cat >&2 <<'EOF'
[start-lan] 找不到 dsh 可执行文件。

请任选一种方式解决：

  1) 确认已全局安装：
       npm i -g @deepseek-ai/dsh

  2) 显式指定路径后重跑：
       DSH_BIN="$(command -v dsh)" bash scripts/start-lan.sh

  3) 若 npm 全局目录不在 PATH，把它加进去（用 npm prefix -g 查看该目录）
EOF
  exit 1
fi

if [ -z "$LAN_IP" ]; then
  # 用共享探测模块（scripts/detect-lan-ip.mjs）：它按接口与网段**排序**候选，
  # 而不是"取第一个非内部地址"。原来那种写法会选中 en0 的自分配地址 169.254.x.x
  # （DHCP 没拿到地址时的 APIPA），打印出来是个"奇怪的 IP"，手机照着连必然失败。
  LAN_IP="$(node "${SCRIPT_DIR}/detect-lan-ip.mjs" 2>/dev/null || true)"
  if [ -n "$LAN_IP" ]; then
    echo "已自动探测局域网地址：${LAN_IP}"
    # 被排除的地址也打出来：用户看到"为什么不是另一个"时不必猜
    node "${SCRIPT_DIR}/detect-lan-ip.mjs" --explain 2>&1 | grep -E "已排除" | sed 's/^/  /' || true
  fi
fi

if [ -z "$LAN_IP" ]; then
  echo "[start-lan] 未能自动探测局域网 IPv4 地址，请显式指定：LAN_IP=10.0.0.5 bash scripts/start-lan.sh" >&2
  exit 1
fi

AUTHORITY="${LAN_IP}:${PROXY_PORT}"
TLS_AUTHORITY="${LAN_IP}:${TLS_PORT}"

# ── IPv6：手机在蜂窝网下走 IPv6 直连（零成本远程），所以这一条不是可选项 ──
#
# ★ 踩过的坑：`restart-lan.sh` 只把 IPv6 authority 传给**装插件**那一步（插件的
#   `/mobile/*` 路由因此认它），却**没有传给 `dsh web` 自己** ✗ ——
#   而 DSH 的 `/api` 信任栅栏是独立的一套（由 `--trusted-host` 决定）。
#   结果是"插件路由在 IPv6 上全通、DSH 的 /api 却 403"，一半配置生效、一半不生效 ✓。
#   实测：`POST https://[<v6>]:3443/api` → 403 forbidden，而 IPv4 是 401（只是没 cookie）。
LAN_IPV6="$(node "${SCRIPT_DIR}/detect-lan-ipv6.mjs" 2>/dev/null || true)"
V6_TLS_AUTHORITY=""
if [ -n "$LAN_IPV6" ]; then
  V6_TLS_AUTHORITY="[${LAN_IPV6}]:${TLS_PORT}"
fi

# ── Tailscale（可选但免费）：手机在校外时经 Tailscale 回到本机，走同一个 TLS 端口 ──
#
# Tailscale 给的是 **IPv4**（100.64.0.0/10 网段），所以 authority 直接写 `ip:端口`，
# **不加方括号** —— 与上面 IPv6 那条恰好相反（方括号是 IPv6 字面量的写法）。
# 它同样要喂给"两个消费者"：装插件（让 /mobile/* 认它）+ 启动 dsh（让 /api 栅栏放行）。
# 探测不到（没装/没登录 Tailscale）时两处都跳过，局域网、IPv6、中继路径完全不受影响。
TS_IP="$(node "${SCRIPT_DIR}/detect-tailscale-ip.mjs" 2>/dev/null || true)"
TS_AUTHORITY=""
if [ -n "$TS_IP" ]; then
  TS_AUTHORITY="${TS_IP}:${TLS_PORT}"
fi
# 需要给"两个消费者"的同一份参数：装插件 + 启动 dsh
TRUST_ARGS=(--trusted-host "${AUTHORITY}" --trusted-host "${TLS_AUTHORITY}")
if [ -n "$V6_TLS_AUTHORITY" ]; then
  TRUST_ARGS+=(--trusted-host "${V6_TLS_AUTHORITY}")
fi
if [ -n "$TS_AUTHORITY" ]; then
  TRUST_ARGS+=(--trusted-host "${TS_AUTHORITY}")
fi
# 但"广告端点"只该给**装插件**那一步：手机侧据此拿到候选端点。喂给 `dsh web` 是无效参数。
TS_INSTALL_ARGS=()
if [ -n "$TS_AUTHORITY" ]; then
  TS_INSTALL_ARGS=(--extra-endpoint "https://${TS_AUTHORITY}")
fi
# 给下面"手工修复命令"用的同一份文字（探测不到 Tailscale 时为空串，命令照样成立）
TS_HINT=""
if [ -n "$TS_AUTHORITY" ]; then
  TS_HINT="--trusted-host ${TS_AUTHORITY} --extra-endpoint https://${TS_AUTHORITY}"
fi

# ── 学校 / 局域网这条 HTTPS 端点（本轮新增 ✓）───────────────────────────
#
# 为什么需要它 ✗：手机侧的候选端点原先是**只有 Tailscale 一条** ✓，而学校那条
# 是明文 HTTP（`http://${LAN_IP}:${PROXY_PORT}` ✓）—— 混合内容 + 清单里的
# `usesCleartextTraffic="false"` 双重不可用 ⇒ 学校槽用不了 ✗。
# 修法就是把**同一个局域网地址的 TLS 端口**作为候选端点广告给手机 ✓
# （手机在校内直连它，不必绕 Tailscale ✓）。
#
# ★ 与 `TS_INSTALL_ARGS` 同一形态、同一个消费者（**只喂装插件那一步** ✓）：
#   它是"广告端点"参数，喂给 `dsh web` 是无效参数 ✗（见上面那条注释 ✓）。
# ★ 只给 `--extra-endpoint` ✓，**不重复给** `--trusted-host` ✗ ——
#   `TLS_AUTHORITY` 早就在 `TRUST_ARGS` 里受信了 ✓。
LAN_INSTALL_ARGS=(--extra-endpoint "https://${TLS_AUTHORITY}")
# 手工修复命令里的那一份（与 TS_HINT 同一个用途 ✓ —— 少了它，用户照抄命令会漏掉学校这条 ✗）
LAN_HINT="--extra-endpoint https://${TLS_AUTHORITY}"

# ── 配置一致性检查 ────────────────────────────────────────────────────
# 插件的 trustedHosts 与 publicBaseUrl 是**安装时**按当时的 IP 写进 profile 的。
# 换了网络（或像这次一样探测到不同地址）之后两者会不一致，表现为：
# 手机拿到一个连不上的地址、或连上了却被信任栅栏 403 拒绝——而报错完全看不出是 IP 变了。
# 这里显式检查并给出**可直接粘贴**的修复命令；SYNC=1 时自动执行。
DSH_HOME_RESOLVED="${DSH_HOME:-$HOME/.dsh}"
PATCH_FILE="${DSH_HOME_RESOLVED}/profiles/web/cordis.patch.yml"
CONFIGURED_AUTHORITY=""
if [ -f "$PATCH_FILE" ]; then
  # ★ 先按**本机局域网 IP** 过滤，再取 head/tail。
  #   这里原本是"直接取第一条/最后一条"，而 Tailscale 那条也是 IPv4 形式、且写在后面 ——
  #   于是 `tail -1` 会把它当成"当前配置的 TLS authority"，每次启动都误报"配置不一致"。
  #   判据必须是"属于本机 LAN_IP"，而不是"在文件里排第几"：以后再加第三、第四条 authority
  #   （IPv6 早已是一条）时，取位置的做法必然重犯。
  CONFIGURED_AUTHORITY="$(grep -oE "^\s+-\s+'?[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+'?" "$PATCH_FILE" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+' | grep -F "${LAN_IP}:" | head -1 || true)"
  CONFIGURED_TLS="$(grep -oE "^\s+-\s+'?[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+'?" "$PATCH_FILE" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+' | grep -F "${LAN_IP}:" | tail -1 || true)"
fi

if [ -n "$CONFIGURED_AUTHORITY" ] && { [ "$CONFIGURED_AUTHORITY" != "$AUTHORITY" ] || [ "$CONFIGURED_TLS" != "$TLS_AUTHORITY" ]; }; then
  echo
  echo "⚠️  配置与本机当前地址不一致："
  echo "      profile 里写的是 : ${CONFIGURED_AUTHORITY} / ${CONFIGURED_TLS:-未配置}"
  echo "      本次探测到的是   : ${AUTHORITY} / ${TLS_AUTHORITY}"
  echo "    继续的话，手机会拿到连不上的地址、或连上后被信任栅栏拒绝。"
  if [ "${SYNC:-0}" = "1" ]; then
    echo "    SYNC=1：正在用新地址重装插件配置…"
    node "${SCRIPT_DIR}/install-host-plugin.mjs" --dsh-home "$DSH_HOME_RESOLVED" \
      "${TRUST_ARGS[@]}" \
      ${TS_INSTALL_ARGS[@]+"${TS_INSTALL_ARGS[@]}"} \
      ${LAN_INSTALL_ARGS[@]+"${LAN_INSTALL_ARGS[@]}"} \
      --phone-base-url "https://${TLS_AUTHORITY}" >/dev/null 2>&1 \
      && echo "    已更新为 ${AUTHORITY}" \
      || { echo "    重装失败，请手动执行下面的命令" >&2; }
  else
    echo "    修复（二选一）："
    echo "      SYNC=1 RESTART=1 bash scripts/start-lan.sh          # 自动重装并重启"
    echo "      node scripts/install-host-plugin.mjs --trusted-host ${AUTHORITY} --trusted-host ${TLS_AUTHORITY} ${TS_HINT} ${LAN_HINT} --phone-base-url https://${TLS_AUTHORITY} && RESTART=1 bash scripts/start-lan.sh"
    echo
  fi
fi

# ── 生成/校验 TLS 证书（手机侧 HTTPS 用）────────────────────────────────
# 证书 SAN 必须含**当前**局域网 IP：IP 变了旧证书就不匹配，手机会一直报警告。
TLS_DIR="${DSH_HOME_RESOLVED}/storages/dsh-mobile/tls"
CERT_FILE="${TLS_DIR}/lan-cert.pem"
KEY_FILE="${TLS_DIR}/lan-key.pem"
CERT_OK=0
if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
  if node "${SCRIPT_DIR}/make-cert.mjs" --print --cert "$CERT_FILE" 2>/dev/null | grep -q "$LAN_IP"; then
    CERT_OK=1
  fi
fi
if [ "$CERT_OK" != "1" ]; then
  echo "[start-lan] 生成自签证书（SAN=${LAN_IP}）→ ${TLS_DIR}"
  node "${SCRIPT_DIR}/make-cert.mjs" --ip "$LAN_IP" --out-dir "$TLS_DIR" || {
    echo "[start-lan] ✗ 证书生成失败，手机将无法使用（HTTPS 是 WebCrypto 的前提）" >&2
    exit 1
  }
fi

echo "dsh            : ${DSH_BIN}"
echo "局域网地址     : ${LAN_IP}"
echo "DSH 端口       : ${DSH_PORT}（仅 loopback）"
echo "代理端口       : ${PROXY_PORT}（0.0.0.0）"
echo "受信 authority : ${AUTHORITY} 与 ${TLS_AUTHORITY}"
echo "学校/局域网    : https://${TLS_AUTHORITY}/mobile（已作为候选端点广告给手机 ✓）"
[ -n "$TS_AUTHORITY" ] && echo "Tailscale      : ${TS_AUTHORITY}（校外入口 https://${TS_AUTHORITY}/mobile）"
echo

# 端口占用前置检查：避免"代理起来了、DSH 却因端口被占而失败"的半死状态。
#
# RESTART=1 时自动停掉**本工具自己的**遗留进程：
#   - 占用 DSH 端口的 dsh web（最常见的场景：本机已跑着一个只绑 loopback 的实例）；
#   - 占用代理端口的**上一次运行留下的孤儿代理**——DSH 退出时代理会变成孤儿并继续
#     占着端口，若只识别 dsh 就会出现"要我停掉它、但我不知道那是什么"的死循环。
#
# 判据是进程命令行里是否含本工具的特征（dsh web / lan-proxy.mjs）。
# 其他占用者一律拒绝自动停止——宁可让用户手动处理，也不误杀无关进程。
if command -v lsof >/dev/null 2>&1; then
  for port in "$DSH_PORT" "$PROXY_PORT"; do
    holder="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
    [ -n "$holder" ] || continue

    if [ "${RESTART:-0}" = "1" ]; then
      holder_cmd="$(ps -p "$holder" -o command= 2>/dev/null || true)"
      case "$holder_cmd" in
        *dsh*web*|*lan-proxy.mjs*)
          case "$holder_cmd" in
            *lan-proxy.mjs*) label="上次遗留的局域网代理" ;;
            *) label="dsh web 实例" ;;
          esac
          echo "端口 ${port} 被${label}占用（PID ${holder}），按 RESTART=1 停止它…"
          kill "$holder" 2>/dev/null || true
          for _ in $(seq 1 20); do
            kill -0 "$holder" 2>/dev/null || break
            sleep 0.5
          done
          if kill -0 "$holder" 2>/dev/null; then
            echo "            PID ${holder} 未在 10 秒内退出，改用 SIGKILL…"
            kill -9 "$holder" 2>/dev/null || true
            sleep 1
          fi
          sleep 1
          continue
          ;;
        *)
          echo "[start-lan] 端口 ${port} 被无关进程占用（PID ${holder}）：${holder_cmd}" >&2
          echo "            出于安全考虑不会自动停止它，请手动处理或换端口。" >&2
          exit 1
          ;;
      esac
    fi

    echo "[start-lan] 端口 ${port} 已被占用（PID ${holder}）。" >&2
    echo "            想自动停掉 dsh 与遗留代理，用：RESTART=1 bash scripts/start-lan.sh" >&2
    echo "            或换端口：DSH_PORT=3090 PROXY_PORT=3091 bash scripts/start-lan.sh" >&2
    exit 1
  done
fi

# 代理：后台运行，退出时一并清理
node "${SCRIPT_DIR}/lan-proxy.mjs" --listen "0.0.0.0:${PROXY_PORT}" --target "127.0.0.1:${DSH_PORT}" \
  --tls-listen "0.0.0.0:${TLS_PORT}" --cert "$CERT_FILE" --key "$KEY_FILE" &
PROXY_PID=$!
cleanup() {
  echo
  echo "正在停止代理（PID ${PROXY_PID}）…"
  kill "$PROXY_PID" 2>/dev/null || true
  wait "$PROXY_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

sleep 1
if ! kill -0 "$PROXY_PID" 2>/dev/null; then
  echo "[start-lan] 代理启动失败，已中止。" >&2
  exit 1
fi

cat <<EOF
代理已就绪。

电脑请访问（本机）  ： http://127.0.0.1:${DSH_PORT}/mobile
手机请访问（局域网）： https://${TLS_AUTHORITY}/mobile   ← 必须 HTTPS

为什么手机必须 HTTPS：普通 HTTP 页面**不是安全上下文**，浏览器不提供 crypto.subtle，
配对与加密隧道都无法工作（症状是 Cannot read properties of undefined (reading 'generateKey')）。
证书是自签的，手机上首次打开会提示"不安全"——选择"继续访问"即可（只需一次）。

为什么两个地址不同（架构约定 B）：
  · 电脑走 loopback —— 生成配对码、确认指纹等管理端点**只允许电脑本机**调用；
    电脑若也用局域网地址，会被插件（正确地）以 403 拒绝。
  · 手机走局域网地址 —— 手机必须能访问配对端点与加密隧道。

配对步骤：
  1.【电脑】打开 http://127.0.0.1:${DSH_PORT}/mobile → 点「生成配对码」→ 点「复制链接」
  2. 把链接发到手机（微信发给自己 / 隔空投送 / 备忘录）
  3.【手机】打开 https://${TLS_AUTHORITY}/mobile（接受一次证书警告）→ 粘贴链接 → 点「确认配对」
  4.【电脑】回到配对页（会自动刷新），逐段比对手机上的指纹 → 点「允许此设备」
  5. 手机自动进入 DSH 界面；日常直接开 https://${TLS_AUTHORITY}/mobile/app

现在启动 DSH（Ctrl-C 会同时停掉代理）…
EOF
echo

# ★ 用 `"${TRUST_ARGS[@]}"` 而不是手写两个：IPv6 的 authority 必须也在这里出现，
#   否则手机在蜂窝网下走 IPv6 时，插件路由能用而 DSH 的 /api 一律 403（见上面的注释）。
exec "$DSH_BIN" web --port "${DSH_PORT}" "${TRUST_ARGS[@]}"
