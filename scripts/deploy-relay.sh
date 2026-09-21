#!/usr/bin/env bash
#
# 把中继部署到一台服务器上。
#
# ## 为什么是"脚本 + systemd"而不是容器
#
# 中继是**纯 I/O 转发**、零依赖（只有 relay.mjs + 一个自包含的 websocket.js），
# 用容器反而多一层需要维护的东西。systemd 直接托管最省事，且开机自启、崩溃自拉。
#
# ## 这个脚本做什么
#
#   1. 生成一个高强度 `relayToken`（或用你给的）；
#   2. 把两个文件拷到服务器；
#   3. 装 systemd 单元（Restart=always、日志进 journald）；
#   4. 打印/执行证书获取（Let's Encrypt **不给纯 IP 签证书**，所以必须要有域名）；
#   5. 打印**电脑侧**要改的配置（relayUrl / relayToken / extraEndpoints / trustedHosts）。
#
# ## 用法
#
#   bash scripts/deploy-relay.sh --host root@1.2.3.4 --domain relay.example.com --email me@example.com
#   bash scripts/deploy-relay.sh --host root@1.2.3.4 --domain relay.example.com --dry-run   # 只看会做什么
#
# 前置：域名 A 记录已指向该服务器；服务器上已装 node（>=22）与 certbot。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

HOST=""
DOMAIN=""
EMAIL=""
PORT="${RELAY_PORT:-443}"
DRY_RUN=0
TOKEN=""

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '3,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "[deploy-relay] 未知参数：${1}" >&2; exit 2 ;;
  esac
done

if [ -z "$HOST" ] || [ -z "$DOMAIN" ]; then
  echo "[deploy-relay] 必须给 --host 与 --domain（域名是必须的：Let's Encrypt 不给纯 IP 签证书，" >&2
  echo "               而手机浏览器需要可信证书才有 crypto.subtle）" >&2
  exit 2
fi

# 密钥：43 字符的 base64url（32 字节熵）。只用于 /attach 的准入，
# 不承担加密职责——内容由两端端到端加密，中继看不懂。
if [ -z "$TOKEN" ]; then
  TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')"
fi

REMOTE_DIR="/opt/dsh-mobile-relay"
UNIT_PATH="/etc/systemd/system/dsh-mobile-relay.service"
CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"

UNIT_CONTENT="[Unit]
Description=dsh-mobile relay (blind byte forwarder for DSH mobile access)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# 密钥经 EnvironmentFile 注入，不写在命令行里（命令行会出现在 ps 输出中）
EnvironmentFile=${REMOTE_DIR}/relay.env
ExecStart=/usr/bin/env node ${REMOTE_DIR}/relay.mjs --tls-listen 0.0.0.0:${PORT} --cert ${CERT_DIR}/fullchain.pem --key ${CERT_DIR}/privkey.pem --token \${DSH_RELAY_TOKEN} --listen 127.0.0.1:4300
Restart=always
RestartSec=3
# 只记计数与错误原因，日志进 journald
StandardOutput=journal
StandardError=journal
# 最小权限：不需要 root，也不需要写任何文件
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target"

echo "[deploy-relay] 目标        : ${HOST}"
echo "[deploy-relay] 域名        : ${DOMAIN}"
echo "[deploy-relay] 监听        : TLS 0.0.0.0:${PORT}（公开）+ 127.0.0.1:4300（仅本机，便于探活）"
echo "[deploy-relay] relayToken  : ${TOKEN}"
echo

if [ "$DRY_RUN" = "1" ]; then
  echo "── 将要拷贝的文件 ──────────────────────────────"
  echo "  scripts/relay.mjs                      → ${REMOTE_DIR}/relay.mjs"
  echo "  packages/host/lib/websocket.js         → ${REMOTE_DIR}/websocket.js"
  echo
  echo "── 将写入 ${REMOTE_DIR}/relay.env ──"
  echo "DSH_RELAY_TOKEN=${TOKEN}"
  echo
  echo "── 将写入 ${UNIT_PATH} ──"
  echo "${UNIT_CONTENT}"
  echo
  echo "── 证书获取（若尚不存在）──"
  echo "  certbot certonly --standalone -d ${DOMAIN} ${EMAIL:+--email ${EMAIL} }--agree-tos -n"
  echo
  echo "── 电脑侧要改的配置（~/.dsh/profiles/web/cordis.patch.yml 的 config 段）──"
  echo "  extraEndpoints:"
  echo "    - 'https://${DOMAIN}'"
  echo "  relayUrl: 'wss://${DOMAIN}/attach'"
  echo "  relayToken: '${TOKEN}'"
  echo "  relayPoolSize: 2"
  echo "  trustedHosts:"
  echo "    - '<电脑局域网IP>:3081'"
  echo "    - '<电脑局域网IP>:3443'"
  echo "    - '${DOMAIN}'"
  echo
  echo "[deploy-relay] --dry-run：未做任何改动"
  exit 0
fi

echo "[deploy-relay] 1/5 创建目录并拷贝文件…"
ssh "$HOST" "mkdir -p '${REMOTE_DIR}'"
# websocket.js 是 relay.mjs 的唯一依赖（自包含，只用 node:crypto）。
# relay.mjs 里 import 的是 '../packages/host/lib/websocket.js'，所以远端按同样的相对结构摆放。
ssh "$HOST" "mkdir -p '${REMOTE_DIR}/packages/host/lib'"
scp -q "$SCRIPT_DIR/relay.mjs" "$HOST:${REMOTE_DIR}/relay.mjs"
scp -q "$REPO_ROOT/packages/host/lib/websocket.js" "$HOST:${REMOTE_DIR}/packages/host/lib/websocket.js"

echo "[deploy-relay] 2/5 写入密钥文件（权限 600）…"
ssh "$HOST" "umask 077 && printf 'DSH_RELAY_TOKEN=%s\n' '${TOKEN}' > '${REMOTE_DIR}/relay.env'"

echo "[deploy-relay] 3/5 申请/检查证书…"
if ssh "$HOST" "test -f '${CERT_DIR}/fullchain.pem'"; then
  echo "  证书已存在，跳过"
else
  ssh "$HOST" "command -v certbot >/dev/null || (echo '服务器上没装 certbot，请先安装' >&2; exit 1)"
  ssh "$HOST" "certbot certonly --standalone -d '${DOMAIN}' ${EMAIL:+--email '${EMAIL}' }--agree-tos -n"
fi

echo "[deploy-relay] 4/5 安装 systemd 单元并启动…"

# ── 启动前的前置检查 ────────────────────────────────────────────────────
# 这两样缺了，服务必然起不来；而 systemd 的报错要翻 journalctl 才看得懂。
# 在这里先说清楚，比让用户在 "Job for … failed" 里猜要好。
missing=""
for tool in node curl; do
  ssh "$HOST" "command -v $tool >/dev/null" || missing="$missing $tool"
done
if [ -n "$missing" ]; then
  echo "[deploy-relay] ✗ 服务器上缺少：${missing}"
  echo "                装 Node（>=22）后重跑本脚本；中继本身零依赖，但要有 node 才能跑。"
  exit 1
fi
# 端口是否已被占用（最常见的失败原因：服务器上已有 nginx/apache 占着 443）
if ssh "$HOST" "ss -ltn 2>/dev/null | grep -q ':${PORT} '"; then
  echo "[deploy-relay] ✗ 服务器上 ${PORT} 端口已被占用（多半是 nginx/apache）。"
  echo "                两种做法：停掉它，或用 --port 换一个端口（记得同步手机与电脑侧的地址）。"
  exit 1
fi

printf '%s\n' "$UNIT_CONTENT" | ssh "$HOST" "cat > '${UNIT_PATH}'"
ssh "$HOST" "systemctl daemon-reload && systemctl enable dsh-mobile-relay" || {
  echo "[deploy-relay] ✗ 写入 systemd 单元失败，请看上面的报错" >&2
  exit 1
}

# ★ 这里**不能**用 `&&` 串起来：脚本开着 `set -e`，服务一旦没起来就会**直接中止**，
#   而后面那段"电脑侧要怎么配"的提示根本不会打印——那正是最需要它的时候。
#   所以：启动与检查分开，失败时**把诊断讲清楚**再退出。
ssh "$HOST" "systemctl restart dsh-mobile-relay" || true
sleep 2
if ! ssh "$HOST" "systemctl is-active --quiet dsh-mobile-relay"; then
  echo "[deploy-relay] ✗ 服务没起来。常见原因与排查："
  echo "    · 443 被占用：ss -ltnp | grep :${PORT}"
  echo "    · 证书路径不对：ls -l ${CERT_DIR}/fullchain.pem ${CERT_DIR}/privkey.pem"
  echo "    · 看日志：ssh ${HOST} 'journalctl -u dsh-mobile-relay -n 40 --no-pager'"
  echo "  修好后重跑本脚本即可（各步骤幂等）。"
  exit 1
fi
echo "[deploy-relay] 服务已启动 ✓"

echo "[deploy-relay] 5/5 本机探活…"
ssh "$HOST" "curl -fsS http://127.0.0.1:4300/healthz" || echo "  （探活失败，看 journalctl -u dsh-mobile-relay）"

echo "[deploy-relay] 6/6 在电脑侧写入中继配置（保留式合并）…"
#
# 用安装脚本写配置，而不是让用户手工编辑 YAML —— 手工那一步我们已经踩过三次
# （抹掉 3443 / phoneBaseUrl / relayUrl，症状分别是"一直重连中"与"远程静默失效"）。
#
# 唯一的坑：安装脚本对 `trustedHosts` 是**重算**的，所以必须把**现有**的 authority
# 一并传回去，否则会被清空。这里从现有 patch 里读出来。
DSH_HOME_RESOLVED="${DSH_HOME:-$HOME/.dsh}"
PATCH_FILE="${DSH_HOME_RESOLVED}/profiles/${PROFILE:-web}/cordis.patch.yml"
EXISTING_AUTHORITIES=()
if [ -f "$PATCH_FILE" ]; then
  while IFS= read -r authority; do
    [ -n "$authority" ] && EXISTING_AUTHORITIES+=("$authority")
  done < <(grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+' "$PATCH_FILE" | sort -u)
fi

INSTALL_ARGS=(--dsh-home "$DSH_HOME_RESOLVED" --profile "${PROFILE:-web}"
  --relay-url "wss://${DOMAIN}/attach" --relay-token "$TOKEN" --relay-pool-size 2
  --extra-endpoint "https://${DOMAIN}")
for authority in "${EXISTING_AUTHORITIES[@]:-}"; do
  [ -n "$authority" ] && INSTALL_ARGS+=(--trusted-host "$authority")
done

if node "$SCRIPT_DIR/install-host-plugin.mjs" "${INSTALL_ARGS[@]}" >/dev/null 2>&1; then
  echo "  已写入：relayUrl / relayToken / relayPoolSize / extraEndpoints"
  echo "  同时保留现有 trustedHosts：${EXISTING_AUTHORITIES[*]:-（无）}"
else
  echo "  ⚠ 自动写入失败，请手工在 ${PATCH_FILE} 的 config 段加入："
  echo "      extraEndpoints: ['https://${DOMAIN}']"
  echo "      relayUrl: 'wss://${DOMAIN}/attach'"
  echo "      relayToken: '${TOKEN}'"
  echo "      relayPoolSize: 2"
fi

cat <<CONFIG

────────────────────────────────────────────────────────
下一步：重启 DSH 让配置生效

  cd $(printf '%q' "$REPO_ROOT") && bash scripts/restart-lan.sh

然后验收：node scripts/check-relay-remote.mjs --url https://${DOMAIN}

说明：中继拓扑下**不需要**把域名加进 trustedHosts —— 手机只连中继，
中继经**回源通道**（回环）访问本机，栅栏本来就把回环请求当"人在电脑前"。
只有"手机直连 DSH"（例如将来做 IPv6 直连优选）才需要把该 authority 加进去。
────────────────────────────────────────────────────────
CONFIG
