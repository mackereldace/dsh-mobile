#!/usr/bin/env bash
# 重启"手机可访问的 DSH"（前台形态），或只做健康检查。
#
# ## 为什么必须是前台、且必须由**你的终端**执行
#
# 这个坑踩了三次，值得写清楚：
#
# 1. 最初用 `RESTART=1 start-lan.sh`。你在自己终端里跑没问题；
#    但由 agent 在会话里执行时，命令是 **DSH 的子进程**——脚本一停掉 DSH，
#    执行它的命令（乃至整个对话）也一起没了。用户反馈："你又重启了"。
# 2. 改用 `nohup` + `setsid` 脱离会话。**依然失败**，两个原因：
#    macOS **没有 `setsid`**（那是 util-linux 的命令），实际只用到 nohup；
#    而 nohup 只忽略 SIGHUP，挡不住父进程退出/进程组被清理。
# 3. 再改用 macOS 的 `launchctl submit`（launchd 接管，确实能脱离进程树，
#    已实测"杀掉目标进程后任务仍继续"）。但仍有两个新问题：
#    - launchd 给的**环境极简**（PATH 里没有 node 所在目录），地址探测会莫名失败；
#    - 它启动的新 DSH 实例仍挂在任务自己的进程树上，任务一结束就被带走（代理收到关闭信号）。
#    而且 launchd 会**反复重试**失败的提交，表现成"一直在启动 3691"，刷屏且难以收拾。
#
# 结论：**不值得**为"从会话内部重启"造机制。正确做法是把重启交回给人：
# 由你在终端里跑，脚本在前台把 DSH 拉起来，Ctrl-C 一起收掉。
# 本脚本因此带一道**自我保护**：检测到自己运行在 DSH 进程链里就拒绝执行。
#
# ## 用法
#
#   bash scripts/restart-lan.sh              # 重启（前台；Ctrl-C 停止 DSH）
#   bash scripts/restart-lan.sh --status      # 只做健康检查（只读，随时可跑）
#
# 前置：DSH_HOME（默认 ~/.dsh）、DSH_PORT（3080）、PROXY_PORT（3081）、TLS_PORT（3443）。
# 重启前会自动把插件配置同步到**当前探测到的局域网地址**（换网络后无需手工改配置），
# 并确保 `listener`（C1：插件内监听）已开启。
#
# ★ 体检里有一条**决定性判据**："谁在监听 PROXY_PORT" —— 搬迁到插件之后，
#   监听者必须是 DSH 自己的进程（`dsh web`），且不得有任何 lan-proxy.mjs 进程
#   还活着。否则会出现"孤儿第三进程占着 3081、体检却全绿"的假成功（见 health_report）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# ★ 仓库根：同样**从脚本自身位置推导** ✓（跨机迁移轮；★ 别占用 `round 152` —— 那是"扫码配对"那一轮）。
#   原先下面那条"拒绝执行"提示里写死了 `/Volumes/Data/workspace/工程设计/dsh-mobile` ✗ ——
#   换机器 / 换目录后，这段提示会把用户指到**不存在的路径** ✗（脚本本身没事，提示害人）。
#   所有路径变量都**必须加引号**：仓库路径含**中文**，且可能含空格 ✗。
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DSH_PORT="${DSH_PORT:-3080}"
PROXY_PORT="${PROXY_PORT:-3081}"
# 手机真正的入口是 **TLS** 端口：明文 HTTP 下浏览器没有 `crypto.subtle`，
# 隧道根本无法建立。本脚本早期只认 PROXY_PORT，于是"体检全绿"但手机连不上
# （真实事故：配置里丢了 3443 这个 authority → 手机侧 403 → 一直"重连中"）。
TLS_PORT="${TLS_PORT:-3443}"
DSH_HOME_RESOLVED="${DSH_HOME:-$HOME/.dsh}"

MODE="restart"
for arg in "$@"; do
  case "$arg" in
    --status|--check-only) MODE="status" ;;
    -h|--help) sed -n '2,35p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "[restart-lan] 未知参数：${arg}（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

# ── 健康检查 ────────────────────────────────────────────────────────────
health_report() {
  local ok=0 code lan_ip configured patch
  # ★★ 这四个变量必须**无条件**先初始化：下面的 `case "$proxy_cmd"` 与
  #    `[ "$holder_is_dsh" = "1" ]` 都在**分支之外**引用它们，而本文件是 `set -u`。
  #    漏掉这一行 = 恰好在那条"最需要诊断"的路径上（端口没人监听 / 占用者不是
  #    dsh web）带着 "未绑定的变量" abort，把"到底谁在监听、怎么修"一并吞掉。
  #    已实测：删掉本行后，空端口场景死在 `case` 那行、非 dsh 占用者场景死在 `elif` 那行。
  local proxy_pid="" proxy_cmd="" orphan_pids="" holder_is_dsh=0
  echo "── 健康检查 ──────────────────────────────────────────"
  if lsof -nP -iTCP:"$DSH_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "  DSH 端口 ${DSH_PORT}                    : 监听中"
  else
    echo "  DSH 端口 ${DSH_PORT}                    : ✗ 未监听"; ok=1
  fi
  if lsof -nP -iTCP:"$PROXY_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "  明文端口 ${PROXY_PORT}                    : 监听中"
  else
    echo "  明文端口 ${PROXY_PORT}                    : ✗ 未监听（手机侧必然不可用）"; ok=1
  fi

  # ★★ 决定性判据（C1：监听已搬进 DSH 插件进程）──────────────────────────
  # 为什么非有不可：DSH 退出时**上一次遗留的孤儿 lan-proxy.mjs 仍然占着 3081**，
  # 于是上面两条"监听中"、下面手机侧 /mobile 的 200 全部为真 —— 体检全绿、
  # 看起来搬迁成功，实际跑的还是那个**该被停用**的第三进程。
  # 所以这里必须问一句"**到底是谁**在监听 3081"，并且同时断言：
  #   · 占用者就是 DSH 自己的进程（`dsh web`；插件内监听跑在这个进程里）；
  #   · **没有任何**命令行含 lan-proxy.mjs 的进程还活着。
  # 两条任一不满足 ⇒ 这一项红，并打印可直接照抄的修法。
  proxy_pid="$(lsof -tiTCP:"$PROXY_PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  if [ -n "$proxy_pid" ]; then
    proxy_cmd="$(ps -p "$proxy_pid" -o command= 2>/dev/null | sed 's/^ *//' || true)"
  fi
  case "$proxy_cmd" in *dsh*web*) holder_is_dsh=1 ;; esac
  if command -v pgrep >/dev/null 2>&1; then
    orphan_pids="$(pgrep -f 'lan-proxy\.mjs' 2>/dev/null | tr '\n' ' ' | sed 's/ *$//' || true)"
  else
    # 没有 pgrep 时退回 ps + grep（`[g]rep` 是为了让它不匹配到自己）
    orphan_pids="$(ps -Ao pid=,command= 2>/dev/null | grep -E 'lan-proxy\.mjs' | grep -v '[g]rep' | awk '{print $1}' | tr '\n' ' ' | sed 's/ *$//' || true)"
  fi
  if [ -n "$proxy_pid" ] && [ "$holder_is_dsh" = "1" ] && [ -z "$orphan_pids" ]; then
    echo "  谁在监听 ${PROXY_PORT}                    : 插件内监听（DSH 进程 PID ${proxy_pid}）"
  else
    echo "  谁在监听 ${PROXY_PORT}                    : ✗ 不是插件在监听 —— 搬迁未生效"; ok=1
    if [ -z "$proxy_pid" ]; then
      echo "      该端口无人监听（同上面那条）。"
    elif [ "$holder_is_dsh" != "1" ]; then
      echo "      占用者 PID ${proxy_pid} 不是 dsh web：${proxy_cmd:-（读不到命令行）}"
    fi
    if [ -n "$orphan_pids" ]; then
      echo "      已废弃的第三进程 lan-proxy.mjs 仍在运行：${orphan_pids}"
    fi
    echo "      修复：先杀掉遗留进程，再重启让 DSH 自己接管 ${PROXY_PORT}："
    [ -n "$orphan_pids" ] && echo "        kill ${orphan_pids}"
    echo "        RESTART=1 bash scripts/restart-lan.sh"
  fi

  code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${DSH_PORT}/mobile" 2>/dev/null)" || code=000
  code="${code:-000}"
  if [ "$code" = "200" ]; then echo "  插件 /mobile                        : 200"
  else echo "  插件 /mobile                        : ✗ ${code}"; ok=1; fi

  # 红线：根路径必须仍是核心鉴权门禁（插件曾抢占它 → 任何浏览器 401 死循环）
  code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${DSH_PORT}/" 2>/dev/null)" || code=000
  code="${code:-000}"
  if [ "$code" = "401" ]; then echo "  根路径 /（红线 401）                 : 401（核心门禁，未被抢占）"
  else echo "  根路径 /（红线 401）                 : ⚠️ ${code}（应为 401）"; ok=1; fi

  lan_ip="$(node "${SCRIPT_DIR}/detect-lan-ip.mjs" 2>/dev/null || true)"
  if [ -n "$lan_ip" ]; then
    code="$(curl -s -m 5 -H "x-forwarded-for: ${lan_ip}" -o /dev/null -w '%{http_code}' "http://${lan_ip}:${PROXY_PORT}/mobile" 2>/dev/null)" || code=000
    code="${code:-000}"
    if [ "$code" = "200" ]; then echo "  手机侧 ${lan_ip}:${PROXY_PORT}/mobile        : 200"
    else echo "  手机侧 ${lan_ip}:${PROXY_PORT}/mobile        : ✗ ${code}"; ok=1; fi

    # ★ 手机实际入口：HTTPS。这里必须用**手机身份**（x-forwarded-for 为非宿主机 IP）
    #   去请求，否则请求会被当成"宿主机自己"而绕过信任栅栏，测出假绿。
    #   今天的事故正是这样漏掉的：从电脑 curl 3443 是 200，手机却是 403。
    code="$(curl -sk -m 5 -H "x-forwarded-for: ${lan_ip}" -o /dev/null -w '%{http_code}' \
      "https://${lan_ip}:${TLS_PORT}/mobile/manifest" 2>/dev/null)" || code=000
    code="${code:-000}"
    if [ "$code" = "200" ]; then
      echo "  手机入口 https://${lan_ip}:${TLS_PORT}/mobile : 200（手机身份，已信任）"
    elif [ "$code" = "403" ]; then
      echo "  手机入口 https://${lan_ip}:${TLS_PORT}/mobile : ✗ 403 —— 该 authority 不在插件 trustedHosts 里"
      echo "      手机侧表现是"一直重连中"。修复："
      echo "      node scripts/install-host-plugin.mjs --trusted-host ${lan_ip}:${PROXY_PORT} \\"
      echo "        --trusted-host ${lan_ip}:${TLS_PORT} --phone-base-url https://${lan_ip}:${TLS_PORT}"
      ok=1
    else
      echo "  手机入口 https://${lan_ip}:${TLS_PORT}/mobile : ✗ ${code}"; ok=1
    fi

    # DSH 自身的 /api 信任栅栏也必须放行该 authority，否则手机业务调用会被 403
    code="$(curl -s -m 5 -H "x-forwarded-for: ${lan_ip}" -H 'content-type: application/json' \
      -o /dev/null -w '%{http_code}' -X POST "http://${lan_ip}:${PROXY_PORT}/api" -d '{}' 2>/dev/null)" || code=000
    code="${code:-000}"
    if [ "$code" = "403" ]; then
      echo "  DSH 信任栅栏 /api ${lan_ip}          : ✗ 403 —— 未信任该 authority（缺 --trusted-host）"; ok=1
    elif [ "$code" = "000" ]; then
      echo "  DSH 信任栅栏 /api ${lan_ip}          : 000（代理未起，无法判定）"
    else
      echo "  DSH 信任栅栏 /api ${lan_ip}          : ${code}（非 403 即已放行）"
    fi

    # IPv6 的 /api 栅栏**单独测**：它与 IPv4 是两条独立配置（曾经只配了插件那一半）
    v6="$(node "${SCRIPT_DIR}/detect-lan-ipv6.mjs" 2>/dev/null || true)"
    if [ -n "$v6" ]; then
      code="$(curl -sk -m 5 -H "x-forwarded-for: ${lan_ip}" -H 'content-type: application/json' \
        -o /dev/null -w '%{http_code}' -X POST "https://[${v6}]:${TLS_PORT}/api" -d '{}' 2>/dev/null)" || code=000
      code="${code:-000}"
      if [ "$code" = "403" ]; then
        echo "  DSH 信任栅栏 /api [${v6}] : ✗ 403 —— 缺 --trusted-host [${v6}]:${TLS_PORT}（手机走蜂窝 IPv6 时会中招）"; ok=1
      elif [ "$code" = "000" ]; then
        echo "  DSH 信任栅栏 /api [${v6}] : 000（不可达，无法判定）"
      else
        echo "  DSH 信任栅栏 /api [${v6}] : ${code}（非 403 即已放行）"
      fi
    fi
    # Tailscale 的 /api 栅栏同样**单独测**：它是第三条独立 authority
    # （手机在校外时就走这条，局域网通不代表它通）。
    ts_ip="$(node "${SCRIPT_DIR}/detect-tailscale-ip.mjs" 2>/dev/null || true)"
    if [ -n "$ts_ip" ]; then
      code="$(curl -sk -m 5 -H "x-forwarded-for: ${lan_ip}" -H 'content-type: application/json' \
        -o /dev/null -w '%{http_code}' -X POST "https://${ts_ip}:${TLS_PORT}/api" -d '{}' 2>/dev/null)" || code=000
      code="${code:-000}"
      if [ "$code" = "403" ]; then
        echo "  DSH 信任栅栏 /api ${ts_ip} : ✗ 403 —— 缺 --trusted-host ${ts_ip}:${TLS_PORT}（手机在校外走 Tailscale 时会中招）"; ok=1
      elif [ "$code" = "000" ]; then
        echo "  DSH 信任栅栏 /api ${ts_ip} : 000（不可达，无法判定）"
      else
        echo "  DSH 信任栅栏 /api ${ts_ip} : ${code}（非 403 即已放行）"
      fi
    fi
  else
    echo "  局域网地址                          : ✗ 未探测到"; ok=1
  fi

  patch="${DSH_HOME_RESOLVED}/profiles/web/cordis.patch.yml"
  configured=""
  configured_tls=""
  if [ -f "$patch" ]; then
    # ★ 只能取**本机局域网 IP** 的 authority（再 head/tail）。
    #   Tailscale 那条也是 IPv4 形式（`100.x.y.z:3443`），会直接顶掉 `tail -1`，
    #   于是体检永远报"配置一致性 ⚠️"、重启也每次都判定不符而重装（吵，且掩盖真变化）。
    configured="$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+' "$patch" | grep -F "${lan_ip}:" | head -1 || true)"
    configured_tls="$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+' "$patch" | grep -F "${lan_ip}:" | tail -1 || true)"
  fi
  # 两个 authority 都要比对：只比第一个，正是"3443 丢了却报绿"的原因。
  if [ -n "$lan_ip" ] && { [ "$configured" != "${lan_ip}:${PROXY_PORT}" ] || [ "$configured_tls" != "${lan_ip}:${TLS_PORT}" ]; }; then
    echo "  配置一致性                          : ⚠️ profile=${configured:-无}/${configured_tls:-无} 本机=${lan_ip}:${PROXY_PORT}/${lan_ip}:${TLS_PORT}"
    ok=1
  else
    echo "  配置一致性                          : profile=${configured:-未配置}/${configured_tls:-未配置}"
  fi
  echo "──────────────────────────────────────────────────────"
  return $ok
}

if [ "$MODE" = "status" ]; then
  health_report
  exit $?
fi

# ── 自我保护：拒绝"从 DSH 会话内部"触发重启 ─────────────────────────────
# 见文件头部的事故说明：从会话内重启会把执行它的会话一起带走，重启只做到一半。
if [ "${ALLOW_FROM_SESSION:-0}" != "1" ]; then
  _pid=$$
  for _ in 1 2 3 4 5 6; do
    _pid="$(ps -o ppid= -p "$_pid" 2>/dev/null | tr -d ' ')"
    [ -z "$_pid" ] && break
    [ "$_pid" = "1" ] && break
    _cmd="$(ps -o command= -p "$_pid" 2>/dev/null || true)"
    case "$_cmd" in
      *dsh*web*)
        # ★ 这里由 `'REFUSE'` 改为 `REFUSE`（去掉单引号）**是故意的** ✓：
        #   下面那段提示要用 `${REPO_DIR}` / `${SCRIPT_DIR}` 展开 ✗ —— 引号版 heredoc 不展开变量 ✗。
        #   安全性已人工核对：本段正文里**没有** `$`、反引号、反斜杠 ✓（有的话会被误展开）。
        #   路径一律**带引号**打印：仓库路径含中文、且可能含空格 ✓。
        cat >&2 <<REFUSE
[restart-lan] ⛔ 拒绝执行：本脚本正运行在**某个 DSH 进程内部**（进程链里出现了 dsh web）。

重启 DSH 会连带终止执行本脚本的那个会话，结果只是"重启到一半"。

请改为在**你自己的终端**里执行：

    cd "${REPO_DIR}"
    bash "${SCRIPT_DIR}/restart-lan.sh"

只查看状态（只读、随时可跑）：

    bash "${SCRIPT_DIR}/restart-lan.sh" --status
REFUSE
        exit 3
        ;;
    esac
  done
fi

# ── 同步配置到当前探测到的局域网地址 ────────────────────────────────────
# 换网络后 profile 里仍是旧地址，手机会拿到连不上的地址、或连上后被 403 拒绝。
LAN_IP="$(node "${SCRIPT_DIR}/detect-lan-ip.mjs" 2>/dev/null || true)"
if [ -z "$LAN_IP" ]; then
  echo "[restart-lan] ✗ 未探测到局域网地址。请显式指定后重试：" >&2
  echo "              LAN_IP=10.0.0.5 bash scripts/restart-lan.sh" >&2
  exit 1
fi
AUTHORITY="${LAN_IP}:${PROXY_PORT}"
TLS_AUTHORITY="${LAN_IP}:${TLS_PORT}"

# ── 学校 / 局域网这条 HTTPS 端点（本轮新增 ✓）───────────────────────────
#
# 为什么需要它 ✗：手机侧原有的候选端点只剩 `TS_AUTHORITY` 一条 ✓，而**学校那条
# 是明文 HTTP**（`http://${LAN_IP}:${PROXY_PORT}` ✓）—— 混合内容 + 清单里的
# `usesCleartextTraffic="false"` 双重不可用 ⇒ 学校槽根本用不了 ✗。
# 所以要把**同一个局域网地址的 TLS 端口**（`https://${TLS_AUTHORITY}` ✓）
# 作为候选端点广告给手机 ✓（手机在校内走它，比绕 Tailscale 快得多 ✓）。
#
# ★ 只给 `--extra-endpoint` ✓，不给 `--trusted-host` ✗ —— `TLS_AUTHORITY` 本来
#   就已经在下面那行 `--trusted-host` 里了 ✓（重复给会写重，没意义 ✓）。
# ★ 加它**不影响** `publicBaseUrl` ✓：安装脚本里 `publicBaseUrl = trustedHosts[0]` ✓，
#   而这条端点派生出的 authority（`${TLS_AUTHORITY}` ✓）**已在** trustedHosts 里 ✓
#   ⇒ `withEndpointAuthorities` 直接跳过、不追加、更不插队 ✓（见该函数注释 ✓）。
LAN_ARGS=(--extra-endpoint "https://${TLS_AUTHORITY}")

# ── 公网 IPv6（可选但免费）：手机在蜂窝网上拿到的往往就是 IPv6 地址，
#    电脑只要有全局 IPv6 就能直连——不需要服务器、不需要域名。
#    IPv6 的 authority **必须带方括号**（Host 头就是这个形式，插件也按这个形式匹配）。
#    探测失败（没有全局 IPv6）时整段跳过，局域网与中继都不受影响。
LAN_IPV6="$(node "${SCRIPT_DIR}/detect-lan-ipv6.mjs" 2>/dev/null || true)"
V6_TLS_AUTHORITY=""
if [ -n "$LAN_IPV6" ]; then
  V6_TLS_AUTHORITY="[${LAN_IPV6}]:${TLS_PORT}"
fi

# ── Tailscale（可选但免费）：手机在校外时经 Tailscale 回到本机。
#    Tailscale 给的是 **IPv4**（100.64.0.0/10 网段），本机已有 TLS 反向代理监听 *:3443，
#    所以 authority 直接写 `ip:端口` —— **不加方括号**。这一点与上面的 IPv6 恰好相反：
#    方括号是 IPv6 字面量的写法，写成 `[100.x.y.z]:3443` 插件既不匹配也解析不了。
#    这条地址同时要**广告给手机**（--extra-endpoint）：手机侧 deriveTunnelUrls 按序自动尝试。
#    探测失败（没装/没登录 Tailscale）时整段跳过，局域网与中继路径完全不受影响。
TS_IP="$(node "${SCRIPT_DIR}/detect-tailscale-ip.mjs" 2>/dev/null || true)"
TS_AUTHORITY=""
if [ -n "$TS_IP" ]; then
  TS_AUTHORITY="${TS_IP}:${TLS_PORT}"
fi
PATCH_FILE="${DSH_HOME_RESOLVED}/profiles/web/cordis.patch.yml"
CONFIGURED=""
CONFIGURED_TLS=""
if [ -f "$PATCH_FILE" ]; then
  # ★ 只取**本机局域网 IP** 的 authority（再 head/tail）。
  #   Tailscale 那条同样是 IPv4 形式（`100.x.y.z:3443`）且写在后面，会把 `tail -1` 抢走 ——
  #   那样每次重启都会判定"配置不符"而重装（无害但吵，而且掩盖真正的变化）。
  CONFIGURED="$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+' "$PATCH_FILE" | grep -F "${LAN_IP}:" | head -1 || true)"
  CONFIGURED_TLS="$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+' "$PATCH_FILE" | grep -F "${LAN_IP}:" | tail -1 || true)"
fi
# ★ 必须把 **两个** authority 都比一遍，并且重装时把两个都传上。
#   这里曾经只比第一个、只传一个，而 install-host-plugin 是**覆盖式**写入：
#   于是"重启一次就把 TLS authority 和 phoneBaseUrl 抹掉"，手机侧 403 一直"重连中"，
#   而本脚本的体检只看明文端口，全绿。用户为此白等了一轮。
# 已配置的 authority 用 IPv4 正则抓，抓不到 IPv6；所以 IPv6 单独比对一次，
# 否则会"每次重启都判定不符 → 反复重装"（无害但吵，而且掩盖真正的变化）。
NEED_V6=0
if [ -n "$V6_TLS_AUTHORITY" ] && [ -f "$PATCH_FILE" ]; then
  grep -qF "$V6_TLS_AUTHORITY" "$PATCH_FILE" || NEED_V6=1
fi
# Tailscale 同理单独比对；但它是 IPv4 形式，会被上面的 IPv4 正则抓到，
# 所以要认**受信列表条目**的准确写法（`'ip:端口'` 带引号），
# 否则 extraEndpoints 里那行 `'https://ip:端口'` 会让检查误判为"已受信"。
NEED_TS=0
if [ -n "$TS_AUTHORITY" ] && [ -f "$PATCH_FILE" ]; then
  grep -qF "'${TS_AUTHORITY}'" "$PATCH_FILE" || NEED_TS=1
fi
# ★ 学校/局域网这条 TLS 同一个道理，也必须**整串带引号**匹配 ✓：
#   它同样是 IPv4 形式，会被上面的 IPv4 正则抓到；而 extraEndpoints 里那行
#   `'https://ip:端口'` 含同样的 `ip:端口` 子串 ⇒ 用不带引号的 `grep -F` 会把它
#   误判成"已受信"✗（少了 trustedHosts 那一条，手机侧就是 403 "一直重连中"✗）。
#   认 `'ip:端口'` 这个准确写法才可靠 ✓。
#
# ★ 再加一条（**这一条才是本轮真正会变化的那个量** ✓）：学校端点还要**真的被广告出去**
#   —— 即 extraEndpoints 这个列表里得有 `'https://ip:端口'` ✓。
#   为什么必须有它 ✗：上面那条"受信条目"**今天就已经在了** ✓（`TLS_AUTHORITY`
#   一直是 `--trusted-host` 的第二个参数 ✓）⇒ 只看它的话 NEED_LAN 恒为 0 ✗，
#   于是"学校槽"这条新端点要等到**别的**原因（文件过期 / 换网）触发重装才会被写上 ✗
#   —— 用户跑一次重启却发现手机上学校槽还是用不了 ✓，正是最难查的那种"改了没生效"✗。
#
#   ★★ 但**不能**拿整文件去 grep 这个串 ✗ —— 实测踩到：`phoneBaseUrl: 'https://ip:端口'`
#   与它**逐字相同** ✓，于是"已广告"的判据会被 phoneBaseUrl 骗过去 ✗
#   ⇒ 学校端点永远写不上 ✗（而且在配置里看起来一切正常 ✗）。
#   所以必须先**只取 extraEndpoints 那一个列表**再比 ✓。
extra_endpoints_of() {
  awk '/^[[:space:]]+extraEndpoints:[[:space:]]*$/ { inside = 1; next }
       inside && /^[[:space:]]+-/ { print; next }
       inside { inside = 0 }' "$1" 2>/dev/null || true
}
NEED_LAN=0
if [ -f "$PATCH_FILE" ]; then
  grep -qF "'${TLS_AUTHORITY}'" "$PATCH_FILE" || NEED_LAN=1
  extra_endpoints_of "$PATCH_FILE" | grep -qF "'https://${TLS_AUTHORITY}'" || NEED_LAN=1
fi

# ── listener（C1：插件内监听）是否已开启 ────────────────────────────────
#
# ★ 它**不随地址变化**，所以要单独判一次。漏掉这一条就会出现：
#   "地址都对、插件文件也不旧" ⇒ 永不重装 ⇒ listener 一直是关的，
#   而 start-lan.sh 里已经是 exec（没有事后补救的机会），手机入口静默全灭。
# 判据限定在 listener 块内（patch 文件里还有别的 `enabled:`，整文件 grep 会误判）。
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
NEED_LISTENER=0
if [ -f "$PATCH_FILE" ] && [ -z "$(listener_enabled_of "$PATCH_FILE")" ]; then
  NEED_LISTENER=1
fi

# ── 插件**文件**是否过期 ────────────────────────────────────────────────
#
# 原先重装只由"配置地址不符"触发。于是最常见的场景会漏掉：
# **改了宿主代码、配置没变** → 重启后跑的仍是旧模块 → 用户看到的是
# "我明明重启了，怎么什么都没变"。这类"改了没生效"在本项目里反复出现，
# 而它与"改坏了"的排查方向完全相反，必须先能区分开。
#
# 用**整目录聚合指纹**比对（而不是抽查几个文件）：抽查会漏——
# 我第一次就只比了 index.js 等 4 个，而"手机上传"那次改的是 workspace-files.js。
# `sort` 是为了让顺序确定（find 的顺序依赖文件系统，不稳定）。
dir_hash() {
  [ -d "$1" ] || { echo ""; return; }
  # ★ 先判空再交给 xargs：目录存在但**为空**时，`xargs` 会让 `shasum` 去读 stdin
  #   （GNU 与 BSD 行为不一致，前者要 `-r`、后者靠实现细节），结果是**脚本挂住**。
  #   测过：空目录下那条管道数秒无输出。重启脚本挂住是最糟的失败形态——用户会以为
  #   "重启卡住了"，而真因只是一个空目录。
  local files
  files="$(cd "$1" && find . -name '*.js' | sort)"
  [ -n "$files" ] || { echo ""; return; }
  (cd "$1" && printf '%s\n' "$files" | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1)
}
NEED_FILES=0
PROFILE_NM="${DSH_HOME_RESOLVED}/profiles/${PROFILE:-web}/node_modules"
for pkg in host protocol; do
  src_hash="$(dir_hash "${SCRIPT_DIR}/../packages/${pkg}/lib")"
  dst_hash="$(dir_hash "${PROFILE_NM}/@dsh-mobile/${pkg}/lib")"
  [ -n "$src_hash" ] && [ "$src_hash" != "$dst_hash" ] && NEED_FILES=1
done
# boot.js 在客户端源码里，装到 host 的 lib 下
if [ -f "${SCRIPT_DIR}/../packages/client/src/boot.js" ]; then
  b_src="$(shasum -a 256 "${SCRIPT_DIR}/../packages/client/src/boot.js" | cut -d' ' -f1)"
  b_dst="$(shasum -a 256 "${PROFILE_NM}/@dsh-mobile/host/lib/boot.js" 2>/dev/null | cut -d' ' -f1)"
  [ "$b_src" != "$b_dst" ] && NEED_FILES=1
fi
if [ "$NEED_FILES" = "1" ]; then
  echo "[restart-lan] 插件文件已过期（仓库里改过、profile 里还是旧的），需要重装"
fi
if [ "$NEED_LISTENER" = "1" ]; then
  echo "[restart-lan] 插件内监听（listener）尚未在 profile 中开启，需要重装配置"
fi

if [ "$CONFIGURED" != "$AUTHORITY" ] || [ "$CONFIGURED_TLS" != "$TLS_AUTHORITY" ] || [ "$NEED_V6" = "1" ] || [ "$NEED_TS" = "1" ] || [ "$NEED_LAN" = "1" ] || [ "$NEED_FILES" = "1" ] || [ "$NEED_LISTENER" = "1" ]; then
  echo "[restart-lan] 配置地址不符（profile=${CONFIGURED:-无}/${CONFIGURED_TLS:-无} / 本机=${AUTHORITY}/${TLS_AUTHORITY}${V6_TLS_AUTHORITY:+ / IPv6=${V6_TLS_AUTHORITY}}${TS_AUTHORITY:+ / Tailscale=${TS_AUTHORITY}}），同步插件配置…"
  # bash 3.2（macOS 自带）在 set -u 下展开空数组会报错，用 ${arr[@]+"${arr[@]}"} 这个惯用写法
  V6_ARGS=()
  if [ -n "$V6_TLS_AUTHORITY" ]; then
    V6_ARGS=(--trusted-host "$V6_TLS_AUTHORITY")
  fi
  # Tailscale 这条要**两样都给**（与 IPv6 那条不同）：
  #   --trusted-host   → 手机直连该 authority 时不被 /api 栅栏 403；
  #   --extra-endpoint → 把它作为**候选端点**广告给手机（否则手机根本不知道有这条路）。
  # 安装脚本侧另有一条不变量兜底：http(s) 端点的 authority 一定会被补进 trustedHosts。
  TS_ARGS=()
  if [ -n "$TS_AUTHORITY" ]; then
    TS_ARGS=(--trusted-host "$TS_AUTHORITY" --extra-endpoint "https://${TS_AUTHORITY}")
  fi
  node "${SCRIPT_DIR}/install-host-plugin.mjs" --dsh-home "$DSH_HOME_RESOLVED" \
    --trusted-host "$AUTHORITY" --trusted-host "$TLS_AUTHORITY" \
    ${V6_ARGS[@]+"${V6_ARGS[@]}"} \
    ${TS_ARGS[@]+"${TS_ARGS[@]}"} \
    ${LAN_ARGS[@]+"${LAN_ARGS[@]}"} \
    --listener \
    --listener-plain "0.0.0.0:${PROXY_PORT}" \
    --listener-tls "0.0.0.0:${TLS_PORT}" \
    --phone-base-url "https://${TLS_AUTHORITY}" \
    || { echo "[restart-lan] ✗ 同步配置失败" >&2; exit 1; }
fi

echo
echo "[restart-lan] 即将重启 DSH："
echo "  DSH_HOME       : ${DSH_HOME_RESOLVED}"
echo "  DSH 端口       : ${DSH_PORT}（仅 loopback）"
echo "  明文端口       : ${PROXY_PORT}（0.0.0.0）"
echo "  TLS 端口       : ${TLS_PORT}（0.0.0.0）"
echo "  监听者         : DSH 插件进程内建的 listener（C1；不再是外置 lan-proxy.mjs）"
echo "  受信 authority : ${AUTHORITY}"
echo "  学校/局域网    : https://${TLS_AUTHORITY}（已作为候选端点广告给手机 ✓）"
[ -n "$TS_AUTHORITY" ] && echo "  Tailscale      : ${TS_AUTHORITY}（已受信并作为候选端点广告给手机）"
echo "  Ctrl-C 停止 DSH，插件内监听随之停止。"
echo

# 交给 start-lan.sh：它负责停旧实例、写 listener 配置、启动 DSH
exec env RESTART=1 DSH_HOME="$DSH_HOME_RESOLVED" DSH_PORT="$DSH_PORT" PROXY_PORT="$PROXY_PORT" \
  bash "${SCRIPT_DIR}/start-lan.sh"
