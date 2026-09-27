#!/usr/bin/env bash
# 启动"手机可访问"的 DSH：DSH 绑 loopback + 插件内局域网监听 + 受信 authority。
#
# 为什么要三步而不是一条 --host 0.0.0.0：
#   DSH 刻意禁用 0.0.0.0 绑定（那会把 agent 的 bash/文件写能力直接暴露到网络）。
#   因此局域网访问由 **DSH 插件进程内**的 listener（C1：明文 3081 / TLS 3443）提供，
#   并让 DSH 显式信任监听端口后的 authority。
#   ★ 没有第三个进程了：原先的 scripts/lan-proxy.mjs 已废弃（仅保留文件本身，
#     不再由任何脚本启动）；监听现在由 DSH 自己的进程承担。
#   ★ listener 由 DSH 在**启动时**读取 profile 配置（config.listener），所以本脚本
#     必须在 exec 之前把配置写好；"端口是否真的被插件接起来"由 restart-lan.sh
#     的 health_report() 负责（判据：谁在监听 PROXY_PORT）。
#
# 用法：
#   bash scripts/start-lan.sh                 # 自动探测局域网 IP，DSH 3080 / 监听 3081+3443
#   RESTART=1 bash scripts/start-lan.sh       # 自动优雅停掉当前的 dsh 实例再启动
#   SYNC=1 bash scripts/start-lan.sh          # 地址不符或 listener 未开时自动重装插件配置
#   DSH_PORT=3080 PROXY_PORT=3081 bash scripts/start-lan.sh
#   LAN_IP=10.0.0.5 bash scripts/start-lan.sh
#   DSH_BIN=/path/to/dsh bash scripts/start-lan.sh   # 覆盖 dsh 入口（默认用全局安装）
# 停止：Ctrl-C（插件内监听随 DSH 进程一起停止）
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
# 手工修复命令：与下面的自动重装**逐参数一致**，含 listener 那四个参数 ——
# 用户照抄它就能把插件内监听打开（漏掉 listener 就不算修复 ✗）。
INSTALL_HINT="node scripts/install-host-plugin.mjs --trusted-host ${AUTHORITY} --trusted-host ${TLS_AUTHORITY} ${TS_HINT} ${LAN_HINT} --listener --listener-plain 0.0.0.0:${PROXY_PORT} --listener-tls 0.0.0.0:${TLS_PORT} --phone-base-url https://${TLS_AUTHORITY}"

# ── 配置一致性检查 ────────────────────────────────────────────────────
# 插件的 trustedHosts 与 publicBaseUrl 是**安装时**按当时的 IP 写进 profile 的。
# 换了网络（或像这次一样探测到不同地址）之后两者会不一致，表现为：
# 手机拿到一个连不上的地址、或连上了却被信任栅栏 403 拒绝——而报错完全看不出是 IP 变了。
# 这里显式检查并给出**可直接粘贴**的修复命令；SYNC=1 时自动执行。
DSH_HOME_RESOLVED="${DSH_HOME:-$HOME/.dsh}"
PATCH_FILE="${DSH_HOME_RESOLVED}/profiles/web/cordis.patch.yml"
CONFIGURED_AUTHORITY=""
# 本次是否已经成功重装过配置（避免下面两处检查各装一次）
CONFIG_SYNCED=0

# 从 profile 里读 `listener: enabled: true`（C1：插件内监听开关）。
# 判据必须**限定在 listener 这个块内**：整个 patch 文件里还有别的 `enabled:`，
# 拿整文件 grep 会误判"已开启"。块的结束由缩进判定（同级或更浅的下一个键）。
listener_enabled_of() {
  awk '
    match($0, /^[[:space:]]*/) { indent = RLENGTH }
    /^[[:space:]]*listener:[[:space:]]*$/ { base = indent; inside = 1; next }
    inside == 1 {
      if ($0 ~ /^[[:space:]]*$/) next
      if (indent <= base) { inside = 0; next }
      if ($0 ~ /^[[:space:]]*enabled:[[:space:]]*true[[:space:]]*(#.*)?$/) found = 1
    }
    END { if (found == 1) print "1" }
  ' "$1" 2>/dev/null || true
}

# 同一份"写插件配置"的动作：本脚本所有自动重装都走它，避免多处参数漂移。
# ★ listener 那四个参数**每次都必须带上**：install-host-plugin.mjs 是覆盖式重写，
#   它内部的保留逻辑能读回 trustedHosts / extraEndpoints / phoneBaseUrl 等已知键，
#   但"这次不传、下次还在"不是本脚本可以依赖的契约。
install_host_plugin() {
  node "${SCRIPT_DIR}/install-host-plugin.mjs" --dsh-home "$DSH_HOME_RESOLVED" \
    "${TRUST_ARGS[@]}" \
    ${TS_INSTALL_ARGS[@]+"${TS_INSTALL_ARGS[@]}"} \
    ${LAN_INSTALL_ARGS[@]+"${LAN_INSTALL_ARGS[@]}"} \
    --listener \
    --listener-plain "0.0.0.0:${PROXY_PORT}" \
    --listener-tls "0.0.0.0:${TLS_PORT}" \
    --phone-base-url "https://${TLS_AUTHORITY}"
}

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
    echo "    SYNC=1：正在用新地址重装插件配置（含 listener）…"
    if install_host_plugin >/dev/null 2>&1; then
      CONFIG_SYNCED=1
      echo "    已更新为 ${AUTHORITY}"
    else
      echo "    重装失败，请手动执行下面的命令" >&2
    fi
  else
    echo "    修复（二选一）："
    echo "      SYNC=1 RESTART=1 bash scripts/start-lan.sh          # 自动重装并重启"
    echo "      ${INSTALL_HINT} && RESTART=1 bash scripts/start-lan.sh"
    echo
  fi
fi

# ── 插件内监听（listener）：配置必须在 `dsh web` 起来**之前**写好 ──────────
#
# ★ 判据问题（本文件末尾是 `exec`，执行完 shell 就被替换掉了）：
#   `listener` 由 DSH 进程**启动时**读取（packages/host/src/cordis.ts 的
#   `config.listener`，**默认关闭**）⇒ "把配置写进去"这件事只能发生在 exec 之前。
#   而"端口是否真的被插件接起来了"在 exec 之后**无法**回头检查（shell 已经没了），
#   所以那一条判据放在 restart-lan.sh 的 health_report() 里：
#   它问的是"到底是谁在监听 PROXY_PORT"，并能识破占着端口的孤儿 lan-proxy.mjs。
#
# ★ 拿不准就**明说**，不许静默：若配置仍是关的，本次启动后不会有任何进程监听
#   3081/3443，手机侧表现为"一直重连中"，而用户在电脑上看到的一切都正常。
LISTENER_ENABLED=0
if [ -f "$PATCH_FILE" ] && [ -n "$(listener_enabled_of "$PATCH_FILE")" ]; then
  LISTENER_ENABLED=1
fi
if [ "$LISTENER_ENABLED" != "1" ] && [ "${SYNC:-0}" = "1" ] && [ "$CONFIG_SYNCED" != "1" ]; then
  echo "[start-lan] profile 里 listener 未开启，SYNC=1：正在写入（含 listener）…"
  if install_host_plugin >/dev/null 2>&1; then
    CONFIG_SYNCED=1
    if [ -n "$(listener_enabled_of "$PATCH_FILE")" ]; then
      LISTENER_ENABLED=1
      echo "[start-lan] ✓ listener 已写入 profile"
    fi
  else
    echo "[start-lan] ✗ 写入 listener 配置失败" >&2
  fi
fi
if [ "$LISTENER_ENABLED" != "1" ]; then
  cat >&2 <<EOF

⚠️  插件内监听（listener）当前**没有开启** —— 手机入口不会生效。

    现状：${PATCH_FILE} 里没有 \`listener: enabled: true\`（缺失 = 关闭）。
    影响：DSH 起来后没有进程监听 ${PROXY_PORT}（明文）/ ${TLS_PORT}（TLS），
          手机会一直"重连中"；而电脑本机看一切正常，很难自己发现。
    本次启动**不会**自动变好 —— 而且**下次启动也不会**，除非重装配置。

    ★ listener 由 DSH 在**启动时**读取 ⇒ 必须"重装配置 + 重启 DSH"两步才生效。
    修复（二选一）：
      SYNC=1 RESTART=1 bash scripts/start-lan.sh          # 自动重装并重启
      ${INSTALL_HINT} && RESTART=1 bash scripts/start-lan.sh

EOF
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
echo "手机入口端口   : ${PROXY_PORT}（明文 0.0.0.0）/ ${TLS_PORT}（TLS 0.0.0.0）——由 DSH 插件进程监听"
if [ "$LISTENER_ENABLED" = "1" ]; then
  echo "listener 配置  : 已开启（config.listener.enabled=true）"
else
  echo "listener 配置  : ✗ 未开启（本次启动手机入口不可用，见上方警告）"
fi
echo "受信 authority : ${AUTHORITY} 与 ${TLS_AUTHORITY}"
echo "学校/局域网    : https://${TLS_AUTHORITY}/mobile（已作为候选端点广告给手机 ✓）"
[ -n "$TS_AUTHORITY" ] && echo "Tailscale      : ${TS_AUTHORITY}（校外入口 https://${TS_AUTHORITY}/mobile）"
echo

# 端口占用前置检查：避免"监听起不来、DSH 却照常启动"的半死状态。
#
# ★ C1 之后 3081（明文）与 3443（TLS）都由 **DSH 自己的进程**监听，而插件里
#   "监听失败只警告不抛错"（见 packages/host/src/lan-listener.ts 的注释，且端口被占时
#   绝不偷偷换端口）⇒ 端口被占的后果就是手机入口静默不可用，所以这里必须前置拦住。
#
# RESTART=1 时自动停掉**本工具自己的**遗留进程：
#   - 占用 DSH 端口的 dsh web（最常见的场景：本机已跑着一个只绑 loopback 的实例）；
#   - 占用监听端口的 dsh web（C1 之后 DSH 自己就是那个监听者）；
#   - **已废弃的旧版第三进程 lan-proxy.mjs**：DSH 退出时它会变成孤儿并继续占着
#     3081/3443，于是"看起来一切正常、其实搬迁没生效"。它只是历史遗留物，
#     不是本工具的正常组件 —— 这里保留的只是"能自动清理自己的遗留进程"这一点。
#
# 判据是进程命令行里是否含本工具的特征（dsh web / 已废弃的 lan-proxy.mjs）。
# 其他占用者一律拒绝自动停止——宁可让用户手动处理，也不误杀无关进程。
if command -v lsof >/dev/null 2>&1; then
  # TLS_PORT 也查：它现在同样是插件在监听，被孤儿占住时手机 HTTPS 入口会静默失效。
  for port in "$DSH_PORT" "$PROXY_PORT" "$TLS_PORT"; do
    holder="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
    [ -n "$holder" ] || continue

    if [ "${RESTART:-0}" = "1" ]; then
      holder_cmd="$(ps -p "$holder" -o command= 2>/dev/null || true)"
      case "$holder_cmd" in
        *dsh*web*|*lan-proxy.mjs*)
          case "$holder_cmd" in
            *lan-proxy.mjs*) label="已废弃的历史遗留进程 lan-proxy.mjs" ;;
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
    echo "            想自动停掉 dsh 与已废弃的遗留 lan-proxy，用：RESTART=1 bash scripts/start-lan.sh" >&2
    echo "            或换端口：DSH_PORT=3090 PROXY_PORT=3091 TLS_PORT=3444 bash scripts/start-lan.sh" >&2
    exit 1
  done
fi

# ── 监听由插件进程承担（C1）────────────────────────────────────────────
# 原先这里在后台起 scripts/lan-proxy.mjs（第三个进程）+ cleanup/trap。
# 现在整段删除：明文 3081 与 TLS 3443 都由 DSH 进程内建的 listener 监听，
# 它同样对每个请求注入 x-forwarded-for（见 lan-listener.ts 的 injectForwardedFor），
# 且"端口被占时只上报、绝不偷偷换端口"。listener 的开关 /
# 地址已在上面写进 profile（必须在 exec 之前），端口是否真的起来见
# restart-lan.sh 的 health_report()。
# ★ 也删掉了原来的 cleanup/trap：本脚本末尾是 exec（前台接管），exec 之后
#   原来的那段 cleanup 本来就不会执行；DSH 退出时插件监听随之消失。

cat <<EOF

监听由 DSH 插件进程提供：明文 ${PROXY_PORT} / TLS ${TLS_PORT}（第三个进程已废弃）。

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

现在启动 DSH（前台；Ctrl-C 停止 DSH，插件内监听随之停止）…
EOF
echo

# ★ 用 `"${TRUST_ARGS[@]}"` 而不是手写两个：IPv6 的 authority 必须也在这里出现，
#   否则手机在蜂窝网下走 IPv6 时，插件路由能用而 DSH 的 /api 一律 403（见上面的注释）。
# ★ listener（明文/TLS 监听）**不在这里传参**：它由 DSH 启动时读 profile 的
#   config.listener（上面已确保写好）。exec 之后本脚本不再有机会校验，
#   所以"端口到底有没有被插件接起来"只能由 restart-lan.sh 的体检来判。
exec "$DSH_BIN" web --port "${DSH_PORT}" "${TRUST_ARGS[@]}"
