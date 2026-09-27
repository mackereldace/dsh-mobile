/**
 * 配对页 HTML —— **由 scripts/gen-pairing-page.mjs 自动生成，请勿手工编辑**。
 * 源文件：packages/host/src/pairing-page.html
 *
 * 生成时间：2026-09-27T16:04:43.189Z
 * 大小：113243 字节
 *
 * ★ 下面两个 sha256 是给校验脚本用的"同步戳" ✓（scripts/check-pairing-page.mjs ✓）：
 *   源 HTML 改过、或 vendored 编码器换过之后**忘了重新跑本脚本** ✗ 时，
 *   构建产物里的 HTML 还是旧的 ✓ ⇒ 那两个戳对不上 ⇒ 校验当场报红 ✗。
 *   为什么不用"比对正文"的办法 ✗：那要把模板字面量转义规则再抄一份 ✓（迟早走偏 ✗）。
 * 源 HTML sha256：f1ca3e138d2ff7bb8e033c5de24f43f5c8b01aceb193e53f0b5cd68784145c88
 * 内联编码器 sha256：b80a0cc76c03d7e441d874df570f8fc93d956c1976d476e1525838d1b5cd71b8
 */
export const PAIRING_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <title>DSH Mobile · 配对</title>
    <link rel="icon" href="/favicon.svg" />
    <style>
      :root {
        --bg: #ffffff;
        --fg: #16181d;
        --muted: #6b7280;
        --line: #e5e7eb;
        --card: #f7f8fa;
        --accent: #4d6bfe;
        --accent-fg: #ffffff;
        --warn: #b45309;
        --danger: #b91c1c;
        --ok: #047857;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #0f1115;
          --fg: #e8eaed;
          --muted: #9aa0aa;
          --line: #262a31;
          --card: #171a20;
          --accent: #6b85ff;
          --accent-fg: #0b0d11;
          --warn: #fbbf24;
          --danger: #f87171;
          --ok: #34d399;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
        background: var(--bg);
        color: var(--fg);
        font: 15px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
        -webkit-text-size-adjust: 100%;
      }
      .wrap { max-width: 560px; margin: 0 auto; }
      h1 { font-size: 20px; margin: 0 0 4px; }
      h2 { font-size: 15px; margin: 24px 0 8px; color: var(--muted); font-weight: 600; }
      p { margin: 8px 0; }
      .muted { color: var(--muted); font-size: 13px; }
      .card {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 16px;
        margin: 12px 0;
      }
      button {
        font: inherit;
        border-radius: 10px;
        border: 1px solid var(--line);
        background: var(--bg);
        color: var(--fg);
        padding: 11px 16px;
        min-height: 44px; /* 触控目标下限 */
        cursor: pointer;
      }
      button.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; font-weight: 600; }
      button.danger { color: var(--danger); }
      button:disabled { opacity: .5; cursor: default; }
      .row { display: flex; gap: 8px; flex-wrap: wrap; }
      code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .code {
        font-size: 34px;
        letter-spacing: 8px;
        text-align: center;
        font-weight: 700;
        margin: 4px 0 0;
      }
      .fp {
        font-size: 13px;
        word-break: break-all;
        line-height: 1.7;
        text-align: center;
      }
      textarea {
        width: 100%;
        font: inherit;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 13px;
        padding: 10px;
        border-radius: 10px;
        border: 1px solid var(--line);
        background: var(--bg);
        color: var(--fg);
        min-height: 84px;
      }
      .dev { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; padding: 10px 0; border-bottom: 1px solid var(--line); }
      .dev:last-child { border-bottom: 0; }
      /*
        二维码（手机要扫的就是这块 ✓）。
        ★ 底色与静区都**不跟随主题色** ✗：白底 + 黑模块是唯一保证高对比的取法 ✓，
          暗色主题下靠 CSS 留白会变成深色边框 ⇒ 直接扫不出来 ✗。
        静区（4 个模块）**烘进画布位图**里，见 renderQr ✓。
      */
      .qr-box {
        margin: 4px auto 6px;
        padding: 0;
        background: #ffffff;
        border: 1px solid var(--line);
        border-radius: 10px;
        max-width: 100%;
        /* 刻意**不写** overflow: hidden ✗：圆角会把画布四角切掉一点点 ✓，
           而那四角正是静区 ✓ —— 宁可不裁 ✓。 */
      }
      .qr-box canvas {
        display: block;
        margin: 0 auto;
        max-width: 100%;
        height: auto;
        /* 放大时保持模块边界锐利（每个模块都是整数像素 ✓） */
        image-rendering: crisp-edges;
        image-rendering: pixelated;
      }
      .qr-placeholder {
        margin: 0;
        padding: 28px 14px;
        text-align: center;
        color: #4b5563;
        font-size: 13px;
        line-height: 1.6;
      }
      .badge { font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
      .badge.ok { color: var(--ok); border-color: currentColor; }
      .badge.warn { color: var(--warn); border-color: currentColor; }
      .badge.danger { color: var(--danger); border-color: currentColor; }
      .note { font-size: 13px; color: var(--muted); }
      .err { color: var(--danger); font-size: 14px; }
      .ok { color: var(--ok); }
      .hide { display: none !important; }
      ol { padding-left: 20px; margin: 8px 0; }
      li { margin: 4px 0; }
    </style>
  </head>
  <body>
    <!--
      屏上错误提示：脚本一旦抛错（含语法错误导致整段不执行的情况），
      这里会显示原因。手机上没有控制台，用户只能靠屏上信息，
      因此这段"兜底提示"是排障的唯一入口，必须放在最前面。
    -->
    <div id="crash" style="display:none;margin:12px;padding:12px;border:1px solid #b91c1c;border-radius:10px;color:#b91c1c;font:13px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap"></div>
    <script>
      window.addEventListener('error', function (event) {
        var box = document.getElementById('crash')
        if (!box) return
        box.style.display = 'block'
        box.textContent = '页面脚本出错：' + (event.message || '未知错误') +
          (event.filename ? '\\n位置：' + event.filename + ':' + event.lineno + ':' + event.colno : '')
      })
      window.addEventListener('unhandledrejection', function (event) {
        var box = document.getElementById('crash')
        if (!box) return
        box.style.display = 'block'
        box.textContent = '页面脚本未处理的错误：' + ((event.reason && event.reason.message) || String(event.reason))
      })
      // 若 3 秒后仍停在"正在加载"，说明启动流程没有跑完，直接告知用户
      setTimeout(function () {
        var subtitle = document.getElementById('subtitle')
        if (subtitle && subtitle.textContent === '正在加载…') {
          var box = document.getElementById('crash')
          if (box && box.style.display === 'none') {
            box.style.display = 'block'
            box.textContent = '页面初始化没有完成（脚本可能未能执行）。请强制刷新（桌面 Ctrl/Cmd+Shift+R）；若仍失败，请把本框内容反馈给开发者。'
          }
        }
      }, 3000)
    </script>
    <div class="wrap">
      <h1>DSH Mobile</h1>
      <p class="muted" id="subtitle">正在加载…</p>

      <!-- 手机侧：配对入口 -->
      <section id="phone" class="hide">
        <div class="card">
          <h2 style="margin-top:0">在这台手机上配对</h2>
          <ol>
            <li>在<strong>电脑</strong>上打开 <span class="mono" id="desktop-url">…</span>，点「生成配对码」</li>
            <li>用手机相机（或壳里的「扫码配对」）扫电脑屏幕上那张<strong>二维码</strong></li>
            <li>扫不动再把电脑上的配对链接复制过来，粘到下面</li>
          </ol>
          <p class="note" id="desktop-url-note"></p>
          <textarea id="link" placeholder="dshmobile://pair?d=..." autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
          <div class="row" style="margin-top:8px">
            <button class="primary" id="do-pair">确认配对</button>
            <button id="scan-qr">扫码配对</button>
          </div>
          <p class="err" id="phone-err"></p>
          <p class="note" id="phone-ok"></p>
        </div>
        <div class="card">
          <div class="row" style="justify-content:space-between;align-items:center">
            <div>
              <strong>连接</strong>
              <div class="muted" id="conn-state">未连接</div>
            </div>
            <button class="primary" id="open-gui">打开 DSH 界面</button>
          </div>
          <p class="note" id="conn-detail"></p>
          <!--
            ★ C2：手机侧也要能看见"证书"这件事（由 renderCaTrust 填）——
            "这台电脑的 CA 指纹"与"手机壳记住了哪一台电脑"摆在一起，
            不一致时给出可操作的那一步（壳的「电脑地址」→「忘记这台电脑」）。
          -->
          <p class="note" id="conn-ca"></p>
        </div>
        <div class="card">
          <h2 style="margin-top:0">已配对的电脑</h2>
          <div id="phone-hosts" class="muted">（无）</div>
        </div>
      </section>

      <!-- 电脑侧：配对控制台 -->
      <section id="desktop" class="hide">
        <div class="card">
          <h2 style="margin-top:0">1. 生成配对码</h2>
          <div class="row">
            <button class="primary" id="gen">生成配对码</button>
            <button id="refresh">刷新</button>
          </div>
          <div id="pairing" class="hide" style="margin-top:12px">
            <!--
              ★ 手机「扫码配对」扫的就是这块 ✓。
              内容**严格**等于 POST /mobile/pair/code 返回的 qrPayload 原文 ✓，
              页面绝不自己拼 dshmobile://pair?d=... ✗（拼错一个字符手机就解析不了 ✓，
              而页面上二维码照样好看 ✗ —— 本项目最怕这种"看着都对"的失败）。
            -->
            <div id="qr-box" class="qr-box">
              <canvas id="qr" class="hide"></canvas>
              <p class="qr-placeholder" id="qr-placeholder">点「生成配对码」后，这里会出现二维码</p>
            </div>
            <p class="note" id="qr-note" style="text-align:center;min-height:18px;margin-top:4px"></p>
            <p class="muted" style="text-align:center">
              用手机相机（或壳里的「扫码配对」）扫上面这张码；下面 6 位数字与链接是<strong>兜底</strong>。
            </p>
            <div class="code mono" id="code">------</div>
            <p class="muted" style="text-align:center;margin-top:0">把这 6 位数字与手机上显示的对照</p>
            <p class="muted">配对链接（也可让手机扫码）：</p>
            <textarea id="payload" readonly style="min-height:64px"></textarea>
            <div class="row" style="margin-top:8px">
              <button id="copy">复制链接</button>
              <span class="note" id="copy-ok"></span>
            </div>
            <p class="note" id="expires"></p>
            <div class="card" style="background:var(--bg);margin-top:12px">
              <p class="muted" style="margin-top:0">手机请打开这个地址（<strong>必须 HTTPS</strong>）：</p>
              <p class="mono" id="phone-url" style="word-break:break-all;margin:4px 0"></p>
              <p class="note" style="margin-bottom:0">
                电脑继续留在这个页面（本机地址 127.0.0.1）操作即可——
                生成配对码、确认指纹都必须在电脑本机完成。
              </p>
            </div>
          </div>
          <!--
            ★ C2：本机 CA 指纹（由 showCaFingerprint 填）。

            为什么非显示不可：APK 不再把 CA 打进包里之后，"首次连接该信任哪张 CA"
            这件事要靠**带外**确认——手机壳从这台电脑取回 CA、算出指纹，
            再拿二维码票据里的指纹比对。两串一致才放行。
            电脑屏幕上这一串是**人眼兜底**：票据里没带指纹（旧宿主）时，
            手机壳会把同一串显示出来、要求用户明确点「信任」。
            分四段显示与手机壳里的分组方式**一致**（壳那边见 MainActivity 的
            formatFingerprintGroups）——分组不一样就没法逐段核对了。

            ★ 放在 #pairing **外面**是刻意的：它不是"这一次配对码"的属性，
              而是**这台电脑**的属性。用户"自己填地址、没扫码"那条路上，
              手机壳会弹确认框要他核对——那时他需要能在电脑上**不生成配对码**
              就看到这一串（放里面的话，得先点一次「生成配对码」才看得见）。
          -->
          <p class="muted" style="margin-top:14px">本机 CA 指纹（首次连接时手机壳会显示同一串，逐段核对）：</p>
          <div class="fp mono" id="ca-fingerprint">（正在读证书…）</div>
          <p class="note" id="ca-fingerprint-note"></p>
        </div>
        </div>

        <div class="card">
          <h2 style="margin-top:0">2. 确认设备指纹</h2>
          <p class="note">
            手机提交请求后会出现在这里。<strong>务必比对手机上显示的指纹与本页是否逐段一致</strong>——
            不一致说明请求来自别的设备，请点「拒绝」。
          </p>
          <div id="pending" class="muted">（暂无待确认设备）</div>
          <!-- ★ 确认/拒绝的**结果**（成功也要说一句 ✓：设备这一刻已登记为已授权 ✓，见 confirmPairing ✓） -->
          <p class="note" id="pairNote" style="margin:10px 0 0"></p>
        </div>

        <div class="card">
          <h2 style="margin-top:0">3. 已授权设备</h2>
          <div id="devices" class="muted">（无）</div>
        </div>
      </section>

      <p class="err" id="fatal"></p>
      <p class="note" style="margin-top:24px">
        说明：本页的配对操作只能从电脑本机发起或确认；手机只能提交配对请求。
        隧道全程端到端加密，电脑身份由配对时比对的指纹固定。
      </p>
    </div>

    <!--
      ★ 二维码编码器（vendored ✓，MIT ✓）：qrcode-generator 2.0.4 ✓。
      来源 URL / 版本 / sha256 / 许可正文：packages/host/assets/qrcode-generator.README.md ✓。
      ★ 下面这段由 scripts/gen-pairing-page.mjs 从
        packages/host/assets/qrcode-generator-2.0.4.js 注入（占位符 __DSHM_QR_VENDOR__ ✓）
        ✗ 不要手改这里 ✗ —— 校验脚本会把它和仓库里那份源码逐字节比对 ✓。
      为什么内联而不是外链：本页要求**零外部请求** ✓（✗ 不许 CDN ✗）。
    -->
    <script>
/* __DSHM_QR_VENDOR_BEGIN__ */
//---------------------------------------------------------------------
//
// QR Code Generator for JavaScript
//
// Copyright (c) 2009 Kazuhiko Arase
//
// URL: http://www.d-project.com/
//
// Licensed under the MIT license:
//  http://www.opensource.org/licenses/mit-license.php
//
// The word 'QR Code' is registered trademark of
// DENSO WAVE INCORPORATED
//  http://www.denso-wave.com/qrcode/faqpatent-e.html
//
//---------------------------------------------------------------------

var qrcode = function() {

  //---------------------------------------------------------------------
  // qrcode
  //---------------------------------------------------------------------

  /**
   * qrcode
   * @param typeNumber 1 to 40
   * @param errorCorrectionLevel 'L','M','Q','H'
   */
  var qrcode = function(typeNumber, errorCorrectionLevel) {

    var PAD0 = 0xEC;
    var PAD1 = 0x11;

    var _typeNumber = typeNumber;
    var _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
    var _modules = null;
    var _moduleCount = 0;
    var _dataCache = null;
    var _dataList = [];

    var _this = {};

    var makeImpl = function(test, maskPattern) {

      _moduleCount = _typeNumber * 4 + 17;
      _modules = function(moduleCount) {
        var modules = new Array(moduleCount);
        for (var row = 0; row < moduleCount; row += 1) {
          modules[row] = new Array(moduleCount);
          for (var col = 0; col < moduleCount; col += 1) {
            modules[row][col] = null;
          }
        }
        return modules;
      }(_moduleCount);

      setupPositionProbePattern(0, 0);
      setupPositionProbePattern(_moduleCount - 7, 0);
      setupPositionProbePattern(0, _moduleCount - 7);
      setupPositionAdjustPattern();
      setupTimingPattern();
      setupTypeInfo(test, maskPattern);

      if (_typeNumber >= 7) {
        setupTypeNumber(test);
      }

      if (_dataCache == null) {
        _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
      }

      mapData(_dataCache, maskPattern);
    };

    var setupPositionProbePattern = function(row, col) {

      for (var r = -1; r <= 7; r += 1) {

        if (row + r <= -1 || _moduleCount <= row + r) continue;

        for (var c = -1; c <= 7; c += 1) {

          if (col + c <= -1 || _moduleCount <= col + c) continue;

          if ( (0 <= r && r <= 6 && (c == 0 || c == 6) )
              || (0 <= c && c <= 6 && (r == 0 || r == 6) )
              || (2 <= r && r <= 4 && 2 <= c && c <= 4) ) {
            _modules[row + r][col + c] = true;
          } else {
            _modules[row + r][col + c] = false;
          }
        }
      }
    };

    var getBestMaskPattern = function() {

      var minLostPoint = 0;
      var pattern = 0;

      for (var i = 0; i < 8; i += 1) {

        makeImpl(true, i);

        var lostPoint = QRUtil.getLostPoint(_this);

        if (i == 0 || minLostPoint > lostPoint) {
          minLostPoint = lostPoint;
          pattern = i;
        }
      }

      return pattern;
    };

    var setupTimingPattern = function() {

      for (var r = 8; r < _moduleCount - 8; r += 1) {
        if (_modules[r][6] != null) {
          continue;
        }
        _modules[r][6] = (r % 2 == 0);
      }

      for (var c = 8; c < _moduleCount - 8; c += 1) {
        if (_modules[6][c] != null) {
          continue;
        }
        _modules[6][c] = (c % 2 == 0);
      }
    };

    var setupPositionAdjustPattern = function() {

      var pos = QRUtil.getPatternPosition(_typeNumber);

      for (var i = 0; i < pos.length; i += 1) {

        for (var j = 0; j < pos.length; j += 1) {

          var row = pos[i];
          var col = pos[j];

          if (_modules[row][col] != null) {
            continue;
          }

          for (var r = -2; r <= 2; r += 1) {

            for (var c = -2; c <= 2; c += 1) {

              if (r == -2 || r == 2 || c == -2 || c == 2
                  || (r == 0 && c == 0) ) {
                _modules[row + r][col + c] = true;
              } else {
                _modules[row + r][col + c] = false;
              }
            }
          }
        }
      }
    };

    var setupTypeNumber = function(test) {

      var bits = QRUtil.getBCHTypeNumber(_typeNumber);

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
      }

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
      }
    };

    var setupTypeInfo = function(test, maskPattern) {

      var data = (_errorCorrectionLevel << 3) | maskPattern;
      var bits = QRUtil.getBCHTypeInfo(data);

      // vertical
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 6) {
          _modules[i][8] = mod;
        } else if (i < 8) {
          _modules[i + 1][8] = mod;
        } else {
          _modules[_moduleCount - 15 + i][8] = mod;
        }
      }

      // horizontal
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 8) {
          _modules[8][_moduleCount - i - 1] = mod;
        } else if (i < 9) {
          _modules[8][15 - i - 1 + 1] = mod;
        } else {
          _modules[8][15 - i - 1] = mod;
        }
      }

      // fixed module
      _modules[_moduleCount - 8][8] = (!test);
    };

    var mapData = function(data, maskPattern) {

      var inc = -1;
      var row = _moduleCount - 1;
      var bitIndex = 7;
      var byteIndex = 0;
      var maskFunc = QRUtil.getMaskFunction(maskPattern);

      for (var col = _moduleCount - 1; col > 0; col -= 2) {

        if (col == 6) col -= 1;

        while (true) {

          for (var c = 0; c < 2; c += 1) {

            if (_modules[row][col - c] == null) {

              var dark = false;

              if (byteIndex < data.length) {
                dark = ( ( (data[byteIndex] >>> bitIndex) & 1) == 1);
              }

              var mask = maskFunc(row, col - c);

              if (mask) {
                dark = !dark;
              }

              _modules[row][col - c] = dark;
              bitIndex -= 1;

              if (bitIndex == -1) {
                byteIndex += 1;
                bitIndex = 7;
              }
            }
          }

          row += inc;

          if (row < 0 || _moduleCount <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    };

    var createBytes = function(buffer, rsBlocks) {

      var offset = 0;

      var maxDcCount = 0;
      var maxEcCount = 0;

      var dcdata = new Array(rsBlocks.length);
      var ecdata = new Array(rsBlocks.length);

      for (var r = 0; r < rsBlocks.length; r += 1) {

        var dcCount = rsBlocks[r].dataCount;
        var ecCount = rsBlocks[r].totalCount - dcCount;

        maxDcCount = Math.max(maxDcCount, dcCount);
        maxEcCount = Math.max(maxEcCount, ecCount);

        dcdata[r] = new Array(dcCount);

        for (var i = 0; i < dcdata[r].length; i += 1) {
          dcdata[r][i] = 0xff & buffer.getBuffer()[i + offset];
        }
        offset += dcCount;

        var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
        var rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);

        var modPoly = rawPoly.mod(rsPoly);
        ecdata[r] = new Array(rsPoly.getLength() - 1);
        for (var i = 0; i < ecdata[r].length; i += 1) {
          var modIndex = i + modPoly.getLength() - ecdata[r].length;
          ecdata[r][i] = (modIndex >= 0)? modPoly.getAt(modIndex) : 0;
        }
      }

      var totalCodeCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalCodeCount += rsBlocks[i].totalCount;
      }

      var data = new Array(totalCodeCount);
      var index = 0;

      for (var i = 0; i < maxDcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < dcdata[r].length) {
            data[index] = dcdata[r][i];
            index += 1;
          }
        }
      }

      for (var i = 0; i < maxEcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < ecdata[r].length) {
            data[index] = ecdata[r][i];
            index += 1;
          }
        }
      }

      return data;
    };

    var createData = function(typeNumber, errorCorrectionLevel, dataList) {

      var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);

      var buffer = qrBitBuffer();

      for (var i = 0; i < dataList.length; i += 1) {
        var data = dataList[i];
        buffer.put(data.getMode(), 4);
        buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
        data.write(buffer);
      }

      // calc num max data.
      var totalDataCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalDataCount += rsBlocks[i].dataCount;
      }

      if (buffer.getLengthInBits() > totalDataCount * 8) {
        throw 'code length overflow. ('
          + buffer.getLengthInBits()
          + '>'
          + totalDataCount * 8
          + ')';
      }

      // end code
      if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
        buffer.put(0, 4);
      }

      // padding
      while (buffer.getLengthInBits() % 8 != 0) {
        buffer.putBit(false);
      }

      // padding
      while (true) {

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD0, 8);

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD1, 8);
      }

      return createBytes(buffer, rsBlocks);
    };

    _this.addData = function(data, mode) {

      mode = mode || 'Byte';

      var newData = null;

      switch(mode) {
      case 'Numeric' :
        newData = qrNumber(data);
        break;
      case 'Alphanumeric' :
        newData = qrAlphaNum(data);
        break;
      case 'Byte' :
        newData = qr8BitByte(data);
        break;
      case 'Kanji' :
        newData = qrKanji(data);
        break;
      default :
        throw 'mode:' + mode;
      }

      _dataList.push(newData);
      _dataCache = null;
    };

    _this.isDark = function(row, col) {
      if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
        throw row + ',' + col;
      }
      return _modules[row][col];
    };

    _this.getModuleCount = function() {
      return _moduleCount;
    };

    _this.make = function() {
      if (_typeNumber < 1) {
        var typeNumber = 1;

        for (; typeNumber < 40; typeNumber++) {
          var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, _errorCorrectionLevel);
          var buffer = qrBitBuffer();

          for (var i = 0; i < _dataList.length; i++) {
            var data = _dataList[i];
            buffer.put(data.getMode(), 4);
            buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
            data.write(buffer);
          }

          var totalDataCount = 0;
          for (var i = 0; i < rsBlocks.length; i++) {
            totalDataCount += rsBlocks[i].dataCount;
          }

          if (buffer.getLengthInBits() <= totalDataCount * 8) {
            break;
          }
        }

        _typeNumber = typeNumber;
      }

      makeImpl(false, getBestMaskPattern() );
    };

    _this.createTableTag = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var qrHtml = '';

      qrHtml += '<table style="';
      qrHtml += ' border-width: 0px; border-style: none;';
      qrHtml += ' border-collapse: collapse;';
      qrHtml += ' padding: 0px; margin: ' + margin + 'px;';
      qrHtml += '">';
      qrHtml += '<tbody>';

      for (var r = 0; r < _this.getModuleCount(); r += 1) {

        qrHtml += '<tr>';

        for (var c = 0; c < _this.getModuleCount(); c += 1) {
          qrHtml += '<td style="';
          qrHtml += ' border-width: 0px; border-style: none;';
          qrHtml += ' border-collapse: collapse;';
          qrHtml += ' padding: 0px; margin: 0px;';
          qrHtml += ' width: ' + cellSize + 'px;';
          qrHtml += ' height: ' + cellSize + 'px;';
          qrHtml += ' background-color: ';
          qrHtml += _this.isDark(r, c)? '#000000' : '#ffffff';
          qrHtml += ';';
          qrHtml += '"/>';
        }

        qrHtml += '</tr>';
      }

      qrHtml += '</tbody>';
      qrHtml += '</table>';

      return qrHtml;
    };

    _this.createSvgTag = function(cellSize, margin, alt, title) {

      var opts = {};
      if (typeof arguments[0] == 'object') {
        // Called by options.
        opts = arguments[0];
        // overwrite cellSize and margin.
        cellSize = opts.cellSize;
        margin = opts.margin;
        alt = opts.alt;
        title = opts.title;
      }

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      // Compose alt property surrogate
      alt = (typeof alt === 'string') ? {text: alt} : alt || {};
      alt.text = alt.text || null;
      alt.id = (alt.text) ? alt.id || 'qrcode-description' : null;

      // Compose title property surrogate
      title = (typeof title === 'string') ? {text: title} : title || {};
      title.text = title.text || null;
      title.id = (title.text) ? title.id || 'qrcode-title' : null;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var c, mc, r, mr, qrSvg='', rect;

      rect = 'l' + cellSize + ',0 0,' + cellSize +
        ' -' + cellSize + ',0 0,-' + cellSize + 'z ';

      qrSvg += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"';
      qrSvg += !opts.scalable ? ' width="' + size + 'px" height="' + size + 'px"' : '';
      qrSvg += ' viewBox="0 0 ' + size + ' ' + size + '" ';
      qrSvg += ' preserveAspectRatio="xMinYMin meet"';
      qrSvg += (title.text || alt.text) ? ' role="img" aria-labelledby="' +
          escapeXml([title.id, alt.id].join(' ').trim() ) + '"' : '';
      qrSvg += '>';
      qrSvg += (title.text) ? '<title id="' + escapeXml(title.id) + '">' +
          escapeXml(title.text) + '</title>' : '';
      qrSvg += (alt.text) ? '<description id="' + escapeXml(alt.id) + '">' +
          escapeXml(alt.text) + '</description>' : '';
      qrSvg += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>';
      qrSvg += '<path d="';

      for (r = 0; r < _this.getModuleCount(); r += 1) {
        mr = r * cellSize + margin;
        for (c = 0; c < _this.getModuleCount(); c += 1) {
          if (_this.isDark(r, c) ) {
            mc = c*cellSize+margin;
            qrSvg += 'M' + mc + ',' + mr + rect;
          }
        }
      }

      qrSvg += '" stroke="transparent" fill="black"/>';
      qrSvg += '</svg>';

      return qrSvg;
    };

    _this.createDataURL = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      return createDataURL(size, size, function(x, y) {
        if (min <= x && x < max && min <= y && y < max) {
          var c = Math.floor( (x - min) / cellSize);
          var r = Math.floor( (y - min) / cellSize);
          return _this.isDark(r, c)? 0 : 1;
        } else {
          return 1;
        }
      } );
    };

    _this.createImgTag = function(cellSize, margin, alt) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;

      var img = '';
      img += '<img';
      img += '\\u0020src="';
      img += _this.createDataURL(cellSize, margin);
      img += '"';
      img += '\\u0020width="';
      img += size;
      img += '"';
      img += '\\u0020height="';
      img += size;
      img += '"';
      if (alt) {
        img += '\\u0020alt="';
        img += escapeXml(alt);
        img += '"';
      }
      img += '/>';

      return img;
    };

    var escapeXml = function(s) {
      var escaped = '';
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charAt(i);
        switch(c) {
        case '<': escaped += '&lt;'; break;
        case '>': escaped += '&gt;'; break;
        case '&': escaped += '&amp;'; break;
        case '"': escaped += '&quot;'; break;
        default : escaped += c; break;
        }
      }
      return escaped;
    };

    var _createHalfASCII = function(margin) {
      var cellSize = 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r1, r2, p;

      var blocks = {
        '██': '█',
        '█ ': '▀',
        ' █': '▄',
        '  ': ' '
      };

      var blocksLastLineNoMargin = {
        '██': '▀',
        '█ ': '▀',
        ' █': ' ',
        '  ': ' '
      };

      var ascii = '';
      for (y = 0; y < size; y += 2) {
        r1 = Math.floor((y - min) / cellSize);
        r2 = Math.floor((y + 1 - min) / cellSize);
        for (x = 0; x < size; x += 1) {
          p = '█';

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) {
            p = ' ';
          }

          if (min <= x && x < max && min <= y+1 && y+1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) {
            p += ' ';
          }
          else {
            p += '█';
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          ascii += (margin < 1 && y+1 >= max) ? blocksLastLineNoMargin[p] : blocks[p];
        }

        ascii += '\\n';
      }

      if (size % 2 && margin > 0) {
        return ascii.substring(0, ascii.length - size - 1) + Array(size+1).join('▀');
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.createASCII = function(cellSize, margin) {
      cellSize = cellSize || 1;

      if (cellSize < 2) {
        return _createHalfASCII(margin);
      }

      cellSize -= 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r, p;

      var white = Array(cellSize+1).join('██');
      var black = Array(cellSize+1).join('  ');

      var ascii = '';
      var line = '';
      for (y = 0; y < size; y += 1) {
        r = Math.floor( (y - min) / cellSize);
        line = '';
        for (x = 0; x < size; x += 1) {
          p = 1;

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) {
            p = 0;
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          line += p ? white : black;
        }

        for (r = 0; r < cellSize; r += 1) {
          ascii += line + '\\n';
        }
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.renderTo2dContext = function(context, cellSize) {
      cellSize = cellSize || 2;
      var length = _this.getModuleCount();
      for (var row = 0; row < length; row++) {
        for (var col = 0; col < length; col++) {
          context.fillStyle = _this.isDark(row, col) ? 'black' : 'white';
          context.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
        }
      }
    }

    return _this;
  };

  //---------------------------------------------------------------------
  // qrcode.stringToBytes
  //---------------------------------------------------------------------

  qrcode.stringToBytesFuncs = {
    'default' : function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        bytes.push(c & 0xff);
      }
      return bytes;
    }
  };

  qrcode.stringToBytes = qrcode.stringToBytesFuncs['default'];

  //---------------------------------------------------------------------
  // qrcode.createStringToBytes
  //---------------------------------------------------------------------

  /**
   * @param unicodeData base64 string of byte array.
   * [16bit Unicode],[16bit Bytes], ...
   * @param numChars
   */
  qrcode.createStringToBytes = function(unicodeData, numChars) {

    // create conversion map.

    var unicodeMap = function() {

      var bin = base64DecodeInputStream(unicodeData);
      var read = function() {
        var b = bin.read();
        if (b == -1) throw 'eof';
        return b;
      };

      var count = 0;
      var unicodeMap = {};
      while (true) {
        var b0 = bin.read();
        if (b0 == -1) break;
        var b1 = read();
        var b2 = read();
        var b3 = read();
        var k = String.fromCharCode( (b0 << 8) | b1);
        var v = (b2 << 8) | b3;
        unicodeMap[k] = v;
        count += 1;
      }
      if (count != numChars) {
        throw count + ' != ' + numChars;
      }

      return unicodeMap;
    }();

    var unknownChar = '?'.charCodeAt(0);

    return function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        if (c < 128) {
          bytes.push(c);
        } else {
          var b = unicodeMap[s.charAt(i)];
          if (typeof b == 'number') {
            if ( (b & 0xff) == b) {
              // 1byte
              bytes.push(b);
            } else {
              // 2bytes
              bytes.push(b >>> 8);
              bytes.push(b & 0xff);
            }
          } else {
            bytes.push(unknownChar);
          }
        }
      }
      return bytes;
    };
  };

  //---------------------------------------------------------------------
  // QRMode
  //---------------------------------------------------------------------

  var QRMode = {
    MODE_NUMBER :    1 << 0,
    MODE_ALPHA_NUM : 1 << 1,
    MODE_8BIT_BYTE : 1 << 2,
    MODE_KANJI :     1 << 3
  };

  //---------------------------------------------------------------------
  // QRErrorCorrectionLevel
  //---------------------------------------------------------------------

  var QRErrorCorrectionLevel = {
    L : 1,
    M : 0,
    Q : 3,
    H : 2
  };

  //---------------------------------------------------------------------
  // QRMaskPattern
  //---------------------------------------------------------------------

  var QRMaskPattern = {
    PATTERN000 : 0,
    PATTERN001 : 1,
    PATTERN010 : 2,
    PATTERN011 : 3,
    PATTERN100 : 4,
    PATTERN101 : 5,
    PATTERN110 : 6,
    PATTERN111 : 7
  };

  //---------------------------------------------------------------------
  // QRUtil
  //---------------------------------------------------------------------

  var QRUtil = function() {

    var PATTERN_POSITION_TABLE = [
      [],
      [6, 18],
      [6, 22],
      [6, 26],
      [6, 30],
      [6, 34],
      [6, 22, 38],
      [6, 24, 42],
      [6, 26, 46],
      [6, 28, 50],
      [6, 30, 54],
      [6, 32, 58],
      [6, 34, 62],
      [6, 26, 46, 66],
      [6, 26, 48, 70],
      [6, 26, 50, 74],
      [6, 30, 54, 78],
      [6, 30, 56, 82],
      [6, 30, 58, 86],
      [6, 34, 62, 90],
      [6, 28, 50, 72, 94],
      [6, 26, 50, 74, 98],
      [6, 30, 54, 78, 102],
      [6, 28, 54, 80, 106],
      [6, 32, 58, 84, 110],
      [6, 30, 58, 86, 114],
      [6, 34, 62, 90, 118],
      [6, 26, 50, 74, 98, 122],
      [6, 30, 54, 78, 102, 126],
      [6, 26, 52, 78, 104, 130],
      [6, 30, 56, 82, 108, 134],
      [6, 34, 60, 86, 112, 138],
      [6, 30, 58, 86, 114, 142],
      [6, 34, 62, 90, 118, 146],
      [6, 30, 54, 78, 102, 126, 150],
      [6, 24, 50, 76, 102, 128, 154],
      [6, 28, 54, 80, 106, 132, 158],
      [6, 32, 58, 84, 110, 136, 162],
      [6, 26, 54, 82, 110, 138, 166],
      [6, 30, 58, 86, 114, 142, 170]
    ];
    var G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
    var G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
    var G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

    var _this = {};

    var getBCHDigit = function(data) {
      var digit = 0;
      while (data != 0) {
        digit += 1;
        data >>>= 1;
      }
      return digit;
    };

    _this.getBCHTypeInfo = function(data) {
      var d = data << 10;
      while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
        d ^= (G15 << (getBCHDigit(d) - getBCHDigit(G15) ) );
      }
      return ( (data << 10) | d) ^ G15_MASK;
    };

    _this.getBCHTypeNumber = function(data) {
      var d = data << 12;
      while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
        d ^= (G18 << (getBCHDigit(d) - getBCHDigit(G18) ) );
      }
      return (data << 12) | d;
    };

    _this.getPatternPosition = function(typeNumber) {
      return PATTERN_POSITION_TABLE[typeNumber - 1];
    };

    _this.getMaskFunction = function(maskPattern) {

      switch (maskPattern) {

      case QRMaskPattern.PATTERN000 :
        return function(i, j) { return (i + j) % 2 == 0; };
      case QRMaskPattern.PATTERN001 :
        return function(i, j) { return i % 2 == 0; };
      case QRMaskPattern.PATTERN010 :
        return function(i, j) { return j % 3 == 0; };
      case QRMaskPattern.PATTERN011 :
        return function(i, j) { return (i + j) % 3 == 0; };
      case QRMaskPattern.PATTERN100 :
        return function(i, j) { return (Math.floor(i / 2) + Math.floor(j / 3) ) % 2 == 0; };
      case QRMaskPattern.PATTERN101 :
        return function(i, j) { return (i * j) % 2 + (i * j) % 3 == 0; };
      case QRMaskPattern.PATTERN110 :
        return function(i, j) { return ( (i * j) % 2 + (i * j) % 3) % 2 == 0; };
      case QRMaskPattern.PATTERN111 :
        return function(i, j) { return ( (i * j) % 3 + (i + j) % 2) % 2 == 0; };

      default :
        throw 'bad maskPattern:' + maskPattern;
      }
    };

    _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
      var a = qrPolynomial([1], 0);
      for (var i = 0; i < errorCorrectLength; i += 1) {
        a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0) );
      }
      return a;
    };

    _this.getLengthInBits = function(mode, type) {

      if (1 <= type && type < 10) {

        // 1 - 9

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 10;
        case QRMode.MODE_ALPHA_NUM : return 9;
        case QRMode.MODE_8BIT_BYTE : return 8;
        case QRMode.MODE_KANJI     : return 8;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 27) {

        // 10 - 26

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 12;
        case QRMode.MODE_ALPHA_NUM : return 11;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 10;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 41) {

        // 27 - 40

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 14;
        case QRMode.MODE_ALPHA_NUM : return 13;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 12;
        default :
          throw 'mode:' + mode;
        }

      } else {
        throw 'type:' + type;
      }
    };

    _this.getLostPoint = function(qrcode) {

      var moduleCount = qrcode.getModuleCount();

      var lostPoint = 0;

      // LEVEL1

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount; col += 1) {

          var sameCount = 0;
          var dark = qrcode.isDark(row, col);

          for (var r = -1; r <= 1; r += 1) {

            if (row + r < 0 || moduleCount <= row + r) {
              continue;
            }

            for (var c = -1; c <= 1; c += 1) {

              if (col + c < 0 || moduleCount <= col + c) {
                continue;
              }

              if (r == 0 && c == 0) {
                continue;
              }

              if (dark == qrcode.isDark(row + r, col + c) ) {
                sameCount += 1;
              }
            }
          }

          if (sameCount > 5) {
            lostPoint += (3 + sameCount - 5);
          }
        }
      };

      // LEVEL2

      for (var row = 0; row < moduleCount - 1; row += 1) {
        for (var col = 0; col < moduleCount - 1; col += 1) {
          var count = 0;
          if (qrcode.isDark(row, col) ) count += 1;
          if (qrcode.isDark(row + 1, col) ) count += 1;
          if (qrcode.isDark(row, col + 1) ) count += 1;
          if (qrcode.isDark(row + 1, col + 1) ) count += 1;
          if (count == 0 || count == 4) {
            lostPoint += 3;
          }
        }
      }

      // LEVEL3

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount - 6; col += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row, col + 1)
              &&  qrcode.isDark(row, col + 2)
              &&  qrcode.isDark(row, col + 3)
              &&  qrcode.isDark(row, col + 4)
              && !qrcode.isDark(row, col + 5)
              &&  qrcode.isDark(row, col + 6) ) {
            lostPoint += 40;
          }
        }
      }

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount - 6; row += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row + 1, col)
              &&  qrcode.isDark(row + 2, col)
              &&  qrcode.isDark(row + 3, col)
              &&  qrcode.isDark(row + 4, col)
              && !qrcode.isDark(row + 5, col)
              &&  qrcode.isDark(row + 6, col) ) {
            lostPoint += 40;
          }
        }
      }

      // LEVEL4

      var darkCount = 0;

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount; row += 1) {
          if (qrcode.isDark(row, col) ) {
            darkCount += 1;
          }
        }
      }

      var ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
      lostPoint += ratio * 10;

      return lostPoint;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // QRMath
  //---------------------------------------------------------------------

  var QRMath = function() {

    var EXP_TABLE = new Array(256);
    var LOG_TABLE = new Array(256);

    // initialize tables
    for (var i = 0; i < 8; i += 1) {
      EXP_TABLE[i] = 1 << i;
    }
    for (var i = 8; i < 256; i += 1) {
      EXP_TABLE[i] = EXP_TABLE[i - 4]
        ^ EXP_TABLE[i - 5]
        ^ EXP_TABLE[i - 6]
        ^ EXP_TABLE[i - 8];
    }
    for (var i = 0; i < 255; i += 1) {
      LOG_TABLE[EXP_TABLE[i] ] = i;
    }

    var _this = {};

    _this.glog = function(n) {

      if (n < 1) {
        throw 'glog(' + n + ')';
      }

      return LOG_TABLE[n];
    };

    _this.gexp = function(n) {

      while (n < 0) {
        n += 255;
      }

      while (n >= 256) {
        n -= 255;
      }

      return EXP_TABLE[n];
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrPolynomial
  //---------------------------------------------------------------------

  function qrPolynomial(num, shift) {

    if (typeof num.length == 'undefined') {
      throw num.length + '/' + shift;
    }

    var _num = function() {
      var offset = 0;
      while (offset < num.length && num[offset] == 0) {
        offset += 1;
      }
      var _num = new Array(num.length - offset + shift);
      for (var i = 0; i < num.length - offset; i += 1) {
        _num[i] = num[i + offset];
      }
      return _num;
    }();

    var _this = {};

    _this.getAt = function(index) {
      return _num[index];
    };

    _this.getLength = function() {
      return _num.length;
    };

    _this.multiply = function(e) {

      var num = new Array(_this.getLength() + e.getLength() - 1);

      for (var i = 0; i < _this.getLength(); i += 1) {
        for (var j = 0; j < e.getLength(); j += 1) {
          num[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i) ) + QRMath.glog(e.getAt(j) ) );
        }
      }

      return qrPolynomial(num, 0);
    };

    _this.mod = function(e) {

      if (_this.getLength() - e.getLength() < 0) {
        return _this;
      }

      var ratio = QRMath.glog(_this.getAt(0) ) - QRMath.glog(e.getAt(0) );

      var num = new Array(_this.getLength() );
      for (var i = 0; i < _this.getLength(); i += 1) {
        num[i] = _this.getAt(i);
      }

      for (var i = 0; i < e.getLength(); i += 1) {
        num[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i) ) + ratio);
      }

      // recursive call
      return qrPolynomial(num, 0).mod(e);
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // QRRSBlock
  //---------------------------------------------------------------------

  var QRRSBlock = function() {

    var RS_BLOCK_TABLE = [

      // L
      // M
      // Q
      // H

      // 1
      [1, 26, 19],
      [1, 26, 16],
      [1, 26, 13],
      [1, 26, 9],

      // 2
      [1, 44, 34],
      [1, 44, 28],
      [1, 44, 22],
      [1, 44, 16],

      // 3
      [1, 70, 55],
      [1, 70, 44],
      [2, 35, 17],
      [2, 35, 13],

      // 4
      [1, 100, 80],
      [2, 50, 32],
      [2, 50, 24],
      [4, 25, 9],

      // 5
      [1, 134, 108],
      [2, 67, 43],
      [2, 33, 15, 2, 34, 16],
      [2, 33, 11, 2, 34, 12],

      // 6
      [2, 86, 68],
      [4, 43, 27],
      [4, 43, 19],
      [4, 43, 15],

      // 7
      [2, 98, 78],
      [4, 49, 31],
      [2, 32, 14, 4, 33, 15],
      [4, 39, 13, 1, 40, 14],

      // 8
      [2, 121, 97],
      [2, 60, 38, 2, 61, 39],
      [4, 40, 18, 2, 41, 19],
      [4, 40, 14, 2, 41, 15],

      // 9
      [2, 146, 116],
      [3, 58, 36, 2, 59, 37],
      [4, 36, 16, 4, 37, 17],
      [4, 36, 12, 4, 37, 13],

      // 10
      [2, 86, 68, 2, 87, 69],
      [4, 69, 43, 1, 70, 44],
      [6, 43, 19, 2, 44, 20],
      [6, 43, 15, 2, 44, 16],

      // 11
      [4, 101, 81],
      [1, 80, 50, 4, 81, 51],
      [4, 50, 22, 4, 51, 23],
      [3, 36, 12, 8, 37, 13],

      // 12
      [2, 116, 92, 2, 117, 93],
      [6, 58, 36, 2, 59, 37],
      [4, 46, 20, 6, 47, 21],
      [7, 42, 14, 4, 43, 15],

      // 13
      [4, 133, 107],
      [8, 59, 37, 1, 60, 38],
      [8, 44, 20, 4, 45, 21],
      [12, 33, 11, 4, 34, 12],

      // 14
      [3, 145, 115, 1, 146, 116],
      [4, 64, 40, 5, 65, 41],
      [11, 36, 16, 5, 37, 17],
      [11, 36, 12, 5, 37, 13],

      // 15
      [5, 109, 87, 1, 110, 88],
      [5, 65, 41, 5, 66, 42],
      [5, 54, 24, 7, 55, 25],
      [11, 36, 12, 7, 37, 13],

      // 16
      [5, 122, 98, 1, 123, 99],
      [7, 73, 45, 3, 74, 46],
      [15, 43, 19, 2, 44, 20],
      [3, 45, 15, 13, 46, 16],

      // 17
      [1, 135, 107, 5, 136, 108],
      [10, 74, 46, 1, 75, 47],
      [1, 50, 22, 15, 51, 23],
      [2, 42, 14, 17, 43, 15],

      // 18
      [5, 150, 120, 1, 151, 121],
      [9, 69, 43, 4, 70, 44],
      [17, 50, 22, 1, 51, 23],
      [2, 42, 14, 19, 43, 15],

      // 19
      [3, 141, 113, 4, 142, 114],
      [3, 70, 44, 11, 71, 45],
      [17, 47, 21, 4, 48, 22],
      [9, 39, 13, 16, 40, 14],

      // 20
      [3, 135, 107, 5, 136, 108],
      [3, 67, 41, 13, 68, 42],
      [15, 54, 24, 5, 55, 25],
      [15, 43, 15, 10, 44, 16],

      // 21
      [4, 144, 116, 4, 145, 117],
      [17, 68, 42],
      [17, 50, 22, 6, 51, 23],
      [19, 46, 16, 6, 47, 17],

      // 22
      [2, 139, 111, 7, 140, 112],
      [17, 74, 46],
      [7, 54, 24, 16, 55, 25],
      [34, 37, 13],

      // 23
      [4, 151, 121, 5, 152, 122],
      [4, 75, 47, 14, 76, 48],
      [11, 54, 24, 14, 55, 25],
      [16, 45, 15, 14, 46, 16],

      // 24
      [6, 147, 117, 4, 148, 118],
      [6, 73, 45, 14, 74, 46],
      [11, 54, 24, 16, 55, 25],
      [30, 46, 16, 2, 47, 17],

      // 25
      [8, 132, 106, 4, 133, 107],
      [8, 75, 47, 13, 76, 48],
      [7, 54, 24, 22, 55, 25],
      [22, 45, 15, 13, 46, 16],

      // 26
      [10, 142, 114, 2, 143, 115],
      [19, 74, 46, 4, 75, 47],
      [28, 50, 22, 6, 51, 23],
      [33, 46, 16, 4, 47, 17],

      // 27
      [8, 152, 122, 4, 153, 123],
      [22, 73, 45, 3, 74, 46],
      [8, 53, 23, 26, 54, 24],
      [12, 45, 15, 28, 46, 16],

      // 28
      [3, 147, 117, 10, 148, 118],
      [3, 73, 45, 23, 74, 46],
      [4, 54, 24, 31, 55, 25],
      [11, 45, 15, 31, 46, 16],

      // 29
      [7, 146, 116, 7, 147, 117],
      [21, 73, 45, 7, 74, 46],
      [1, 53, 23, 37, 54, 24],
      [19, 45, 15, 26, 46, 16],

      // 30
      [5, 145, 115, 10, 146, 116],
      [19, 75, 47, 10, 76, 48],
      [15, 54, 24, 25, 55, 25],
      [23, 45, 15, 25, 46, 16],

      // 31
      [13, 145, 115, 3, 146, 116],
      [2, 74, 46, 29, 75, 47],
      [42, 54, 24, 1, 55, 25],
      [23, 45, 15, 28, 46, 16],

      // 32
      [17, 145, 115],
      [10, 74, 46, 23, 75, 47],
      [10, 54, 24, 35, 55, 25],
      [19, 45, 15, 35, 46, 16],

      // 33
      [17, 145, 115, 1, 146, 116],
      [14, 74, 46, 21, 75, 47],
      [29, 54, 24, 19, 55, 25],
      [11, 45, 15, 46, 46, 16],

      // 34
      [13, 145, 115, 6, 146, 116],
      [14, 74, 46, 23, 75, 47],
      [44, 54, 24, 7, 55, 25],
      [59, 46, 16, 1, 47, 17],

      // 35
      [12, 151, 121, 7, 152, 122],
      [12, 75, 47, 26, 76, 48],
      [39, 54, 24, 14, 55, 25],
      [22, 45, 15, 41, 46, 16],

      // 36
      [6, 151, 121, 14, 152, 122],
      [6, 75, 47, 34, 76, 48],
      [46, 54, 24, 10, 55, 25],
      [2, 45, 15, 64, 46, 16],

      // 37
      [17, 152, 122, 4, 153, 123],
      [29, 74, 46, 14, 75, 47],
      [49, 54, 24, 10, 55, 25],
      [24, 45, 15, 46, 46, 16],

      // 38
      [4, 152, 122, 18, 153, 123],
      [13, 74, 46, 32, 75, 47],
      [48, 54, 24, 14, 55, 25],
      [42, 45, 15, 32, 46, 16],

      // 39
      [20, 147, 117, 4, 148, 118],
      [40, 75, 47, 7, 76, 48],
      [43, 54, 24, 22, 55, 25],
      [10, 45, 15, 67, 46, 16],

      // 40
      [19, 148, 118, 6, 149, 119],
      [18, 75, 47, 31, 76, 48],
      [34, 54, 24, 34, 55, 25],
      [20, 45, 15, 61, 46, 16]
    ];

    var qrRSBlock = function(totalCount, dataCount) {
      var _this = {};
      _this.totalCount = totalCount;
      _this.dataCount = dataCount;
      return _this;
    };

    var _this = {};

    var getRsBlockTable = function(typeNumber, errorCorrectionLevel) {

      switch(errorCorrectionLevel) {
      case QRErrorCorrectionLevel.L :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
      case QRErrorCorrectionLevel.M :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
      case QRErrorCorrectionLevel.Q :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
      case QRErrorCorrectionLevel.H :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
      default :
        return undefined;
      }
    };

    _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {

      var rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);

      if (typeof rsBlock == 'undefined') {
        throw 'bad rs block @ typeNumber:' + typeNumber +
            '/errorCorrectionLevel:' + errorCorrectionLevel;
      }

      var length = rsBlock.length / 3;

      var list = [];

      for (var i = 0; i < length; i += 1) {

        var count = rsBlock[i * 3 + 0];
        var totalCount = rsBlock[i * 3 + 1];
        var dataCount = rsBlock[i * 3 + 2];

        for (var j = 0; j < count; j += 1) {
          list.push(qrRSBlock(totalCount, dataCount) );
        }
      }

      return list;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrBitBuffer
  //---------------------------------------------------------------------

  var qrBitBuffer = function() {

    var _buffer = [];
    var _length = 0;

    var _this = {};

    _this.getBuffer = function() {
      return _buffer;
    };

    _this.getAt = function(index) {
      var bufIndex = Math.floor(index / 8);
      return ( (_buffer[bufIndex] >>> (7 - index % 8) ) & 1) == 1;
    };

    _this.put = function(num, length) {
      for (var i = 0; i < length; i += 1) {
        _this.putBit( ( (num >>> (length - i - 1) ) & 1) == 1);
      }
    };

    _this.getLengthInBits = function() {
      return _length;
    };

    _this.putBit = function(bit) {

      var bufIndex = Math.floor(_length / 8);
      if (_buffer.length <= bufIndex) {
        _buffer.push(0);
      }

      if (bit) {
        _buffer[bufIndex] |= (0x80 >>> (_length % 8) );
      }

      _length += 1;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrNumber
  //---------------------------------------------------------------------

  var qrNumber = function(data) {

    var _mode = QRMode.MODE_NUMBER;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var data = _data;

      var i = 0;

      while (i + 2 < data.length) {
        buffer.put(strToNum(data.substring(i, i + 3) ), 10);
        i += 3;
      }

      if (i < data.length) {
        if (data.length - i == 1) {
          buffer.put(strToNum(data.substring(i, i + 1) ), 4);
        } else if (data.length - i == 2) {
          buffer.put(strToNum(data.substring(i, i + 2) ), 7);
        }
      }
    };

    var strToNum = function(s) {
      var num = 0;
      for (var i = 0; i < s.length; i += 1) {
        num = num * 10 + chatToNum(s.charAt(i) );
      }
      return num;
    };

    var chatToNum = function(c) {
      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      }
      throw 'illegal char :' + c;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrAlphaNum
  //---------------------------------------------------------------------

  var qrAlphaNum = function(data) {

    var _mode = QRMode.MODE_ALPHA_NUM;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var s = _data;

      var i = 0;

      while (i + 1 < s.length) {
        buffer.put(
          getCode(s.charAt(i) ) * 45 +
          getCode(s.charAt(i + 1) ), 11);
        i += 2;
      }

      if (i < s.length) {
        buffer.put(getCode(s.charAt(i) ), 6);
      }
    };

    var getCode = function(c) {

      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      } else if ('A' <= c && c <= 'Z') {
        return c.charCodeAt(0) - 'A'.charCodeAt(0) + 10;
      } else {
        switch (c) {
        case ' ' : return 36;
        case '$' : return 37;
        case '%' : return 38;
        case '*' : return 39;
        case '+' : return 40;
        case '-' : return 41;
        case '.' : return 42;
        case '/' : return 43;
        case ':' : return 44;
        default :
          throw 'illegal char :' + c;
        }
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qr8BitByte
  //---------------------------------------------------------------------

  var qr8BitByte = function(data) {

    var _mode = QRMode.MODE_8BIT_BYTE;
    var _data = data;
    var _bytes = qrcode.stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _bytes.length;
    };

    _this.write = function(buffer) {
      for (var i = 0; i < _bytes.length; i += 1) {
        buffer.put(_bytes[i], 8);
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrKanji
  //---------------------------------------------------------------------

  var qrKanji = function(data) {

    var _mode = QRMode.MODE_KANJI;
    var _data = data;

    var stringToBytes = qrcode.stringToBytesFuncs['SJIS'];
    if (!stringToBytes) {
      throw 'sjis not supported.';
    }
    !function(c, code) {
      // self test for sjis support.
      var test = stringToBytes(c);
      if (test.length != 2 || ( (test[0] << 8) | test[1]) != code) {
        throw 'sjis not supported.';
      }
    }('\\u53cb', 0x9746);

    var _bytes = stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return ~~(_bytes.length / 2);
    };

    _this.write = function(buffer) {

      var data = _bytes;

      var i = 0;

      while (i + 1 < data.length) {

        var c = ( (0xff & data[i]) << 8) | (0xff & data[i + 1]);

        if (0x8140 <= c && c <= 0x9FFC) {
          c -= 0x8140;
        } else if (0xE040 <= c && c <= 0xEBBF) {
          c -= 0xC140;
        } else {
          throw 'illegal char at ' + (i + 1) + '/' + c;
        }

        c = ( (c >>> 8) & 0xff) * 0xC0 + (c & 0xff);

        buffer.put(c, 13);

        i += 2;
      }

      if (i < data.length) {
        throw 'illegal char at ' + (i + 1);
      }
    };

    return _this;
  };

  //=====================================================================
  // GIF Support etc.
  //

  //---------------------------------------------------------------------
  // byteArrayOutputStream
  //---------------------------------------------------------------------

  var byteArrayOutputStream = function() {

    var _bytes = [];

    var _this = {};

    _this.writeByte = function(b) {
      _bytes.push(b & 0xff);
    };

    _this.writeShort = function(i) {
      _this.writeByte(i);
      _this.writeByte(i >>> 8);
    };

    _this.writeBytes = function(b, off, len) {
      off = off || 0;
      len = len || b.length;
      for (var i = 0; i < len; i += 1) {
        _this.writeByte(b[i + off]);
      }
    };

    _this.writeString = function(s) {
      for (var i = 0; i < s.length; i += 1) {
        _this.writeByte(s.charCodeAt(i) );
      }
    };

    _this.toByteArray = function() {
      return _bytes;
    };

    _this.toString = function() {
      var s = '';
      s += '[';
      for (var i = 0; i < _bytes.length; i += 1) {
        if (i > 0) {
          s += ',';
        }
        s += _bytes[i];
      }
      s += ']';
      return s;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64EncodeOutputStream
  //---------------------------------------------------------------------

  var base64EncodeOutputStream = function() {

    var _buffer = 0;
    var _buflen = 0;
    var _length = 0;
    var _base64 = '';

    var _this = {};

    var writeEncoded = function(b) {
      _base64 += String.fromCharCode(encode(b & 0x3f) );
    };

    var encode = function(n) {
      if (n < 0) {
        // error.
      } else if (n < 26) {
        return 0x41 + n;
      } else if (n < 52) {
        return 0x61 + (n - 26);
      } else if (n < 62) {
        return 0x30 + (n - 52);
      } else if (n == 62) {
        return 0x2b;
      } else if (n == 63) {
        return 0x2f;
      }
      throw 'n:' + n;
    };

    _this.writeByte = function(n) {

      _buffer = (_buffer << 8) | (n & 0xff);
      _buflen += 8;
      _length += 1;

      while (_buflen >= 6) {
        writeEncoded(_buffer >>> (_buflen - 6) );
        _buflen -= 6;
      }
    };

    _this.flush = function() {

      if (_buflen > 0) {
        writeEncoded(_buffer << (6 - _buflen) );
        _buffer = 0;
        _buflen = 0;
      }

      if (_length % 3 != 0) {
        // padding
        var padlen = 3 - _length % 3;
        for (var i = 0; i < padlen; i += 1) {
          _base64 += '=';
        }
      }
    };

    _this.toString = function() {
      return _base64;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64DecodeInputStream
  //---------------------------------------------------------------------

  var base64DecodeInputStream = function(str) {

    var _str = str;
    var _pos = 0;
    var _buffer = 0;
    var _buflen = 0;

    var _this = {};

    _this.read = function() {

      while (_buflen < 8) {

        if (_pos >= _str.length) {
          if (_buflen == 0) {
            return -1;
          }
          throw 'unexpected end of file./' + _buflen;
        }

        var c = _str.charAt(_pos);
        _pos += 1;

        if (c == '=') {
          _buflen = 0;
          return -1;
        } else if (c.match(/^\\s$/) ) {
          // ignore if whitespace.
          continue;
        }

        _buffer = (_buffer << 6) | decode(c.charCodeAt(0) );
        _buflen += 6;
      }

      var n = (_buffer >>> (_buflen - 8) ) & 0xff;
      _buflen -= 8;
      return n;
    };

    var decode = function(c) {
      if (0x41 <= c && c <= 0x5a) {
        return c - 0x41;
      } else if (0x61 <= c && c <= 0x7a) {
        return c - 0x61 + 26;
      } else if (0x30 <= c && c <= 0x39) {
        return c - 0x30 + 52;
      } else if (c == 0x2b) {
        return 62;
      } else if (c == 0x2f) {
        return 63;
      } else {
        throw 'c:' + c;
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // gifImage (B/W)
  //---------------------------------------------------------------------

  var gifImage = function(width, height) {

    var _width = width;
    var _height = height;
    var _data = new Array(width * height);

    var _this = {};

    _this.setPixel = function(x, y, pixel) {
      _data[y * _width + x] = pixel;
    };

    _this.write = function(out) {

      //---------------------------------
      // GIF Signature

      out.writeString('GIF87a');

      //---------------------------------
      // Screen Descriptor

      out.writeShort(_width);
      out.writeShort(_height);

      out.writeByte(0x80); // 2bit
      out.writeByte(0);
      out.writeByte(0);

      //---------------------------------
      // Global Color Map

      // black
      out.writeByte(0x00);
      out.writeByte(0x00);
      out.writeByte(0x00);

      // white
      out.writeByte(0xff);
      out.writeByte(0xff);
      out.writeByte(0xff);

      //---------------------------------
      // Image Descriptor

      out.writeString(',');
      out.writeShort(0);
      out.writeShort(0);
      out.writeShort(_width);
      out.writeShort(_height);
      out.writeByte(0);

      //---------------------------------
      // Local Color Map

      //---------------------------------
      // Raster Data

      var lzwMinCodeSize = 2;
      var raster = getLZWRaster(lzwMinCodeSize);

      out.writeByte(lzwMinCodeSize);

      var offset = 0;

      while (raster.length - offset > 255) {
        out.writeByte(255);
        out.writeBytes(raster, offset, 255);
        offset += 255;
      }

      out.writeByte(raster.length - offset);
      out.writeBytes(raster, offset, raster.length - offset);
      out.writeByte(0x00);

      //---------------------------------
      // GIF Terminator
      out.writeString(';');
    };

    var bitOutputStream = function(out) {

      var _out = out;
      var _bitLength = 0;
      var _bitBuffer = 0;

      var _this = {};

      _this.write = function(data, length) {

        if ( (data >>> length) != 0) {
          throw 'length over';
        }

        while (_bitLength + length >= 8) {
          _out.writeByte(0xff & ( (data << _bitLength) | _bitBuffer) );
          length -= (8 - _bitLength);
          data >>>= (8 - _bitLength);
          _bitBuffer = 0;
          _bitLength = 0;
        }

        _bitBuffer = (data << _bitLength) | _bitBuffer;
        _bitLength = _bitLength + length;
      };

      _this.flush = function() {
        if (_bitLength > 0) {
          _out.writeByte(_bitBuffer);
        }
      };

      return _this;
    };

    var getLZWRaster = function(lzwMinCodeSize) {

      var clearCode = 1 << lzwMinCodeSize;
      var endCode = (1 << lzwMinCodeSize) + 1;
      var bitLength = lzwMinCodeSize + 1;

      // Setup LZWTable
      var table = lzwTable();

      for (var i = 0; i < clearCode; i += 1) {
        table.add(String.fromCharCode(i) );
      }
      table.add(String.fromCharCode(clearCode) );
      table.add(String.fromCharCode(endCode) );

      var byteOut = byteArrayOutputStream();
      var bitOut = bitOutputStream(byteOut);

      // clear code
      bitOut.write(clearCode, bitLength);

      var dataIndex = 0;

      var s = String.fromCharCode(_data[dataIndex]);
      dataIndex += 1;

      while (dataIndex < _data.length) {

        var c = String.fromCharCode(_data[dataIndex]);
        dataIndex += 1;

        if (table.contains(s + c) ) {

          s = s + c;

        } else {

          bitOut.write(table.indexOf(s), bitLength);

          if (table.size() < 0xfff) {

            if (table.size() == (1 << bitLength) ) {
              bitLength += 1;
            }

            table.add(s + c);
          }

          s = c;
        }
      }

      bitOut.write(table.indexOf(s), bitLength);

      // end code
      bitOut.write(endCode, bitLength);

      bitOut.flush();

      return byteOut.toByteArray();
    };

    var lzwTable = function() {

      var _map = {};
      var _size = 0;

      var _this = {};

      _this.add = function(key) {
        if (_this.contains(key) ) {
          throw 'dup key:' + key;
        }
        _map[key] = _size;
        _size += 1;
      };

      _this.size = function() {
        return _size;
      };

      _this.indexOf = function(key) {
        return _map[key];
      };

      _this.contains = function(key) {
        return typeof _map[key] != 'undefined';
      };

      return _this;
    };

    return _this;
  };

  var createDataURL = function(width, height, getPixel) {
    var gif = gifImage(width, height);
    for (var y = 0; y < height; y += 1) {
      for (var x = 0; x < width; x += 1) {
        gif.setPixel(x, y, getPixel(x, y) );
      }
    }

    var b = byteArrayOutputStream();
    gif.write(b);

    var base64 = base64EncodeOutputStream();
    var bytes = b.toByteArray();
    for (var i = 0; i < bytes.length; i += 1) {
      base64.writeByte(bytes[i]);
    }
    base64.flush();

    return 'data:image/gif;base64,' + base64;
  };

  //---------------------------------------------------------------------
  // returns qrcode function.

  return qrcode;
}();

// multibyte support
!function() {

  qrcode.stringToBytesFuncs['UTF-8'] = function(s) {
    // http://stackoverflow.com/questions/18729405/how-to-convert-utf8-string-to-byte-array
    function toUTF8Array(str) {
      var utf8 = [];
      for (var i=0; i < str.length; i++) {
        var charcode = str.charCodeAt(i);
        if (charcode < 0x80) utf8.push(charcode);
        else if (charcode < 0x800) {
          utf8.push(0xc0 | (charcode >> 6),
              0x80 | (charcode & 0x3f));
        }
        else if (charcode < 0xd800 || charcode >= 0xe000) {
          utf8.push(0xe0 | (charcode >> 12),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
        // surrogate pair
        else {
          i++;
          // UTF-16 encodes 0x10000-0x10FFFF by
          // subtracting 0x10000 and splitting the
          // 20 bits of 0x0-0xFFFFF into two halves
          charcode = 0x10000 + (((charcode & 0x3ff)<<10)
            | (str.charCodeAt(i) & 0x3ff));
          utf8.push(0xf0 | (charcode >>18),
              0x80 | ((charcode>>12) & 0x3f),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
      }
      return utf8;
    }
    return toUTF8Array(s);
  };

}();

(function (factory) {
  if (typeof define === 'function' && define.amd) {
      define([], factory);
  } else if (typeof exports === 'object') {
      module.exports = factory();
  }
}(function () {
    return qrcode;
}));
/* __DSHM_QR_VENDOR_END__ */
    </script>

    <script>
      'use strict'
      var API = ''
      // phoneBaseUrl：手机应访问的基地址（来自 manifest，见 generatePairing 的说明）
      // expiresAt：当前配对码的到期毫秒数（用来把过期的二维码从屏幕上撤掉，见 checkPairingExpiry）
      var state = { profile: null, tunnel: null, code: null, timer: null, phoneBaseUrl: null, expiresAt: null, caFingerprint: null }

      /**
       * 官方可选的 UTF-8 覆盖 ✓（上游 dist/qrcode_UTF8.js 的**全部内容**就是这一行 ✓）。
       *
       * 本页的载荷是纯 ASCII（dshmobile://pair?d=<base64url> ✓），两种编码等价 ✓；
       * 装上它是为了将来谁塞进非 ASCII 时也不会**悄悄**编错 ✗。
       * typeof 守卫是刻意的：编码器万一没被注入 ✓，本页的兜底路径
       * （6 位数字 + 粘贴链接 ✓）也不该跟着整段脚本一起挂掉 ✗。
       */
      if (typeof qrcode === 'function') qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8']

      function $(id) { return document.getElementById(id) }
      function show(id, visible) { $(id).classList.toggle('hide', !visible) }
      function text(id, value) { $(id).textContent = value }

      function formatFingerprint(hex) {
        if (!hex) return ''
        return (hex.match(/.{1,4}/g) || []).join('-').toUpperCase()
      }

      /**
       * ★ C2：CA 指纹的分段显示（每 4 个十六进制字符一组）。
       *
       * 为什么不直接复用上面那个 formatFingerprint：
       *   那个函数的输入是**纯十六进制**（主机/设备指纹），它按"每 4 个字符"切；
       *   而宿主的 tls.caFingerprint 是 Node 的 X509Certificate.fingerprint256 写法
       *   —— **冒号分隔**（AB:CD:EF:…）。直接喂给 formatFingerprint，
       *   切出来的段会**错位**（AB:C-D:EF-…）⇒ 与手机壳上那一串对不上，
       *   而"对不上"在下一次连接时表现为"指纹不一致、拒绝连接"——
       *   人会以为是中间人，其实是显示格式不一致。
       *   所以这里先**清掉所有非十六进制字符**再分组。
       *
       * shortOnly = 只取前 16 个十六进制字符（= 前 4 组）。
       * 壳那边显示的也是这 4 组（见 MainActivity.pinnedCaFingerprint / formatFingerprintGroups），
       * 两边**必须同一种分组方式**，否则人眼比对没有意义。
       * （★ 本文件**一个反引号都不能有** ✗ —— scripts/gen-pairing-page.mjs 会直接拒绝 ✓，
       *   因为它要把整页嵌进模板字面量 ✓ ⇒ 注释里也别用反引号 ✓。）
       */
      function caFingerprintGroups(value, shortOnly) {
        var hexValue = String(value || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase()
        if (hexValue.length < 8) return ''
        if (shortOnly) hexValue = hexValue.slice(0, 16)
        return (hexValue.match(/.{1,4}/g) || []).join('-')
      }

      /** 电脑侧：把本机 CA 指纹摆出来（人眼比对的参照物）。 */
      function showCaFingerprint() {
        var raw = state.caFingerprint
        if (!raw) {
          text('ca-fingerprint', '（读不到本机 CA 指纹）')
          text('ca-fingerprint-note', '宿主没有提供 tls.caFingerprint（未注入证书管理器，或证书坏了）——手机首次连接时会退回"显示指纹、要你点「信任」"这条路，仍然不会盲信。')
          return
        }
        text('ca-fingerprint', caFingerprintGroups(raw, false))
        text('ca-fingerprint-note', '前 16 位：' + caFingerprintGroups(raw, true) + '（手机壳上显示的也是前 16 位）')
      }

      /**
       * ★ C2：手机侧把"这台电脑的 CA 指纹"与"手机壳记住了哪一台"摆在一起。
       *
       * 为什么两边都要显示：
       *   · 只显示电脑侧那一串 ⇒ 用户看不出手机壳当时确认的到底是哪一串；
       *   · 只显示手机侧那一串 ⇒ 换了电脑之后，用户不知道"手机还在信任上一台"。
       * 两串摆在一起，不一致时直接给出**可操作的那一步**（壳→「电脑地址」→
       * 勾「忘记这台电脑」→ 重新配对），而不是让用户对着"连不上"猜。
       *
       * 桥的返回值见 MainActivity.ShellBridge.pinnedCaFingerprint：
       * {"short":"AB12-CD34-EF56-7890","source":"pinned"} / {"short":"","source":"none"}。
       * 旧 APK 没有这条桥 ⇒ typeof !== 'function' ⇒ 只显示电脑侧那一串（不报错）✓。
       */
      function renderCaTrust() {
        var hostSide = state.caFingerprint ? caFingerprintGroups(state.caFingerprint, true) : ''
        var parts = []
        parts.push(hostSide ? '这台电脑的 CA 指纹：' + hostSide : '这台电脑没给出 CA 指纹（宿主未注入证书管理器）')
        var bridge = typeof window === 'undefined' ? undefined : window.DshmShell
        if (bridge === undefined || bridge === null || typeof bridge.pinnedCaFingerprint !== 'function') {
          parts.push('（这个页面不在壳里，或者壳的版本还没有"已固定指纹"这条桥——无法显示手机记住了哪一台。）')
          text('conn-ca', parts.join(' '))
          return
        }
        var pinned = null
        try {
          pinned = JSON.parse(bridge.pinnedCaFingerprint())
        } catch (error) {
          pinned = null
        }
        if (pinned === null || typeof pinned.short !== 'string') {
          parts.push('（壳没有回答"记住了哪一台电脑"，无法核对。）')
        } else if (!pinned.short) {
          parts.push('手机还没有记住任何电脑的证书：第一次连接会先让你核对指纹再放行。')
        } else if (hostSide && pinned.short === hostSide) {
          parts.push('手机记住的证书：' + pinned.short + '（与这台电脑一致）')
        } else {
          parts.push('手机记住的是「另一台」电脑的证书：' + pinned.short + '。要连这台电脑，请在壳的「电脑地址」框里勾上「忘记这台电脑」再重新配对。')
        }
        text('conn-ca', parts.join(' '))
      }

      async function api(path, options) {
        var response = await fetch(API + path, Object.assign({ headers: { 'content-type': 'application/json' } }, options || {}))
        var body = null
        try { body = await response.json() } catch (e) { body = null }
        if (!response.ok) {
          var message = body && body.message ? body.message : 'HTTP ' + response.status
          throw new Error(message)
        }
        return body
      }

      // ───────────────────────── 手机侧 ─────────────────────────

      var STORE_KEY = 'dsh-mobile.host'

      function readStored() {
        try { var raw = localStorage.getItem(STORE_KEY); return raw ? JSON.parse(raw) : null } catch (e) { return null }
      }

      /** 解析配对链接，取出宿主指纹、票据与候选地址。 */
      function parseLink(value) {
        var trimmed = String(value || '').trim()
        // 用 startsWith 而不是 slice：曾经写成 slice(0, 11)，而 'dshmobile:' 只有 10 个字符，
        // 于是比较恒为假——手机端**永远**解析不了任何配对链接，表现是"手机就是配不上"。
        // 这类"差一位"的常量错误语法上完全合法，只有真机流程才能发现。
        if (!trimmed.startsWith('dshmobile:')) throw new Error('这不是 DSH 的配对链接')
        var query = trimmed.split('?')[1] || ''
        var params = new URLSearchParams(query)
        var payload = params.get('d')
        if (!payload) throw new Error('配对链接缺少数据字段')
        var normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
        while (normalized.length % 4 !== 0) normalized += '='
        var binary = atob(normalized)
        var bytes = new Uint8Array(binary.length)
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        return JSON.parse(new TextDecoder().decode(bytes))
      }

      async function doPair() {
        text('phone-err', '')
        text('phone-ok', '')
        try {
          var ticket = parseLink($('link').value)
          if (ticket.expiresAt && Date.parse(ticket.expiresAt) <= Date.now()) throw new Error('配对码已过期，请在电脑上重新生成')

          // claim 由手机发起：指纹必须与公钥自洽，服务端会校验
          var device = await ensureDeviceKey()
          await api('/mobile/pair/claim', {
            method: 'POST',
            body: JSON.stringify({
              ticket: ticket.ticket,
              deviceId: device.deviceId,
              deviceSigningKey: device.publicKey,
              fingerprint: device.fingerprint,
              name: guessDeviceName(),
              platform: 'web',
            }),
          })

          // 把配置写下来后跳转到 DSH 界面：boot.js 会自动发起隧道连接并持续重试。
          //
          // 为什么不轮询配对状态：/mobile/pair/status 与其它管理端点一样只允许
          // 电脑本机访问（安全模型使然）。手机的"等待批准"就体现在隧道连不上这件事上——
          // 电脑一点允许，下一次重试就会成功。这样既不需要放宽权限，
          // 也不需要为设备管理额外实现一套 Remote 命名空间。
          //
          // 存储形状必须与 boot.js 完全一致（含 pairingTicket）：boot.js 的
          // readStoredHost() 直接把它当配置用，票据能省掉一次 URL 解析；
          // 而 pinnedHostFingerprint 是防中间人的关键——丢了它 boot.js 会接受
          // 任何自签的宿主身份。
          localStorage.setItem(STORE_KEY, JSON.stringify({
            baseUrl: location.origin,
            tunnelUrl: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/mobile/ws',
            pairingTicket: ticket.ticket,
            pairingCode: ticket.code,
            pinnedHostFingerprint: ticket.hostFingerprint,
          }))
          text('phone-ok', '已提交。请在电脑上核对指纹并点「允许此设备」——允许后本页会自动进入 DSH 界面。')
          renderPhoneHosts()
          // 给电脑端一点确认时间后进入界面（界面会自行重连直到成功）。
          //
          // 形状约定：?pair= 必须是**整个 ticket 对象**的 base64url(UTF-8 JSON)，
          // 与 boot.js 的 readUrlConfig() 一一对应。这里曾只传 ticket.ticket 裸串，
          // 结果手机进入 GUI 后解析失败、拿不到指纹而连不上——两处必须一起改。
          var encoded = encodeTicketPayload(ticket)
          setTimeout(function () { location.href = '/mobile/app?pair=' + encodeURIComponent(encoded) }, 2500)
        } catch (error) {
          text('phone-err', String(error && error.message ? error.message : error))
        }
      }

      function guessDeviceName() {
        var ua = navigator.userAgent
        var match = /Android[^;]*;\\s*([^)]+)\\)/.exec(ua) || /\\((iPhone|iPad)[^)]*\\)/.exec(ua)
        return (match && match[1] ? match[1].trim() : '手机浏览器').slice(0, 40)
      }

      /** 生成并保存设备签名密钥（P-256，浏览器本地）。 */
      async function ensureDeviceKey() {
        var KEY = 'dsh-mobile.device-key'
        var stored = localStorage.getItem(KEY)
        if (stored) {
          try {
            var parsed = JSON.parse(stored)
            var raw = unb64u(parsed.publicKey)
            var digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw))
            return { deviceId: parsed.deviceId, publicKey: parsed.publicKey, fingerprint: hex(digest.subarray(0, 16)) }
          } catch (e) { /* 存储损坏则重新生成 */ }
        }
        var pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
        var pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
        var jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
        var publicKey = b64u(pub)
        var deviceId = 'web-' + b64u(crypto.getRandomValues(new Uint8Array(9)))
        localStorage.setItem(KEY, JSON.stringify({ deviceId: deviceId, publicKey: publicKey, privateKeyJwk: jwk }))
        var d = new Uint8Array(await crypto.subtle.digest('SHA-256', pub))
        return { deviceId: deviceId, publicKey: publicKey, fingerprint: hex(d.subarray(0, 16)) }
      }

      function hex(bytes) {
        var out = ''
        for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0')
        return out
      }
      function b64u(bytes) {
        var s = ''
        for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
        return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
      }
      function unb64u(v) {
        var n = String(v).replace(/-/g, '+').replace(/_/g, '/')
        while (n.length % 4 !== 0) n += '='
        var bin = atob(n); var out = new Uint8Array(bin.length)
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
        return out
      }

      /**
       * 把整个 ticket 编成 ?pair= 参数的取值。
       *
       * 为什么不是 encodeURIComponent(JSON.stringify(ticket))：ticket 里有中文/特殊字符时
       * 百分号编码会让 URL 变得很长，而且 base64url 与 boot.js 的解码路径完全对称。
       * 与 boot.js 的 JSON.parse(fromUtf8(unb64u(token))) 严格对应。
       */
      function encodeTicketPayload(ticket) {
        var json = JSON.stringify(ticket)
        var utf8 = new TextEncoder().encode(json)
        return b64u(utf8)
      }

      /** 建立加密隧道（与 boot.js 同一套协议，这里只用于展示连接状态）。 */
      async function connectTunnel() {
        var stored = readStored()
        if (!stored) throw new Error('尚未配对')
        var boot = window.__DSH_MOBILE_BOOT__
        if (!boot || !boot.tunnel) {
          // boot.js 只在电脑端注入的页面里存在；本页是独立页面，因此这里只做可达性检查
          var manifest = await api('/mobile/manifest')
          text('conn-state', '已配对')
          text('conn-detail', '主机指纹 ' + formatFingerprint(manifest.hostFingerprint) + '；打开 DSH 界面即会自动建立加密隧道。')
          renderPhoneHosts()
          return
        }
        await boot.tunnel.connect()
        text('conn-state', '已连接')
      }

      function renderPhoneHosts() {
        var stored = readStored()
        var host = $('phone-hosts')
        if (!stored) { host.textContent = '（无）'; return }
        host.innerHTML = ''
        var div = document.createElement('div')
        div.className = 'dev'
        var left = document.createElement('div')
        var name = document.createElement('div')
        name.innerHTML = '<strong>' + escapeHtml(location.host) + '</strong>'
        var fp = document.createElement('div')
        fp.className = 'mono muted'
        fp.style.fontSize = '12px'
        fp.textContent = formatFingerprint(stored.pinnedHostFingerprint)
        left.appendChild(name); left.appendChild(fp)
        var button = document.createElement('button')
        button.className = 'danger'
        button.textContent = '解除'
        button.onclick = function () {
          localStorage.removeItem(STORE_KEY)
          localStorage.removeItem('dsh-mobile.device-key')
          location.reload()
        }
        div.appendChild(left); div.appendChild(button)
        host.appendChild(div)
      }

      function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, function (c) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        })
      }

      function openGui() {
        var stored = readStored()
        if (!stored) { text('conn-detail', '请先完成配对'); return }
        // 走插件自己的 /mobile/app 外壳。**绝不能走根路径**：那是 DSH 的 token/cookie
        // 认证入口（唯一的一条），插件曾用 path:'/' 抢占它，导致 token 兑换永不执行、
        // 任何浏览器打开都是 401 死循环。详见 packages/host/src/cordis.ts 的事故注释。
        location.href = '/mobile/app'
      }

      /**
       * 「扫码配对」—— 手机侧那颗按钮（round 152 起**真的会扫码** ✓）。
       *
       * ★ 此前它是**一句提示** ✗：只往 phone-err 写"请用手机相机扫描…" ✓，
       *   既不打开任何扫码界面、页面上也没有任何能调起的桥 ✗ ⇒
       *   用户点下去看到的就是"什么都不发生" ✗（**这正是用户报的那条** ✓）。
       *
       * 现在按"这一页跑在哪里"分两条路 ✓（判据是壳注入的 DshmShell ✓，
       * 与 boot.js 里 shellBridge() 用的是同一个 ✓）：
       *   ① **壳里**（dshmobile 的 WebView ✓ —— 例如「连接与设备」→「在这台手机上解除配对」
       *      之后 location.href = '/mobile' 回到本页 ✓）⇒ 调 DshmShell.scanPair() ✓：
       *      壳打开**自己的相机** ✓，扫到的文本走**与深链同一条**地址状态机 ✓
       *      （见 MainActivity 的 handlePairText ✓，那里只有一份实现 ✓）；
       *   ② **纯浏览器**（没有壳 ✓）⇒ **如实说**"这里没有相机扫码能力" ✓，
       *      并给出两条真能走的路（手机自带的相机／扫码 App ✓、把链接粘进输入框 ✓）——
       *      绝不假装自己能扫 ✗（旧版那句提示的毛病不在文案，在于它被当成了"功能" ✗）。
       *
       * 返回值契约见 MainActivity.ShellBridge.scanPair ✓：
       *   ok / busy（已经开着一个 ✓）/ untrusted（不是这台电脑的页面 ✗）/ error。
       * ★ 旧 APK 没有这条桥 ⇒ typeof !== 'function' ⇒ 落到 ② 那条降级 ✓（不报错、不白屏 ✓）。
       */
      function scanQr() {
        text('phone-ok', '')
        var bridge = typeof window === 'undefined' ? undefined : window.DshmShell
        if (bridge === undefined || bridge === null || typeof bridge.scanPair !== 'function') {
          text('phone-err', '当前页面没有相机扫码能力（不在 dshmobile 壳里，或壳的版本太旧）。请用手机自带的相机／扫码 App 扫电脑屏幕上那张二维码——扫出来的链接会直接进 dshmobile；或者把电脑上的配对链接复制到上面的输入框。')
          return
        }
        var result
        try {
          result = bridge.scanPair()
        } catch (error) {
          text('phone-err', '打不开扫码界面：' + String(error && error.message ? error.message : error))
          return
        }
        if (result === 'ok') {
          text('phone-err', '')
          text('phone-ok', '已打开壳内扫码界面——对准电脑屏幕上那张二维码即可。')
          return
        }
        if (result === 'busy') {
          text('phone-err', '扫码界面已经打开了——对准电脑屏幕上的二维码即可。')
          return
        }
        if (result === 'untrusted') {
          text('phone-err', '当前页面不是这台电脑的页面，壳拒绝了扫码请求。')
          return
        }
        text('phone-err', '打不开扫码界面（' + String(result) + '）。请改用手机自带相机扫，或把配对链接粘到上面的输入框。')
      }

      // ───────────────────────── 电脑侧 ─────────────────────────

      /**
       * 二维码的三个常量（改这里就等于改"能不能扫出来" ✓）。
       *
       * · **纠错等级 M** ✓：屏幕反光/摩尔纹下比 L 稳 ✓，体积也还能接受 ✓
       *   （实测宿主真实载荷：341 字符 ⇒ 73×73 模块 ✓）；
       * · **静区 4 模块** ✓：规范下限就是 4 ✓，没有静区**扫不出来** ✗；
       * · **上限 480px** ✓：内容区本身约 496px ✓，再大也没意义 ✓。
       */
      var QR_ERROR_CORRECTION = 'M'
      var QR_QUIET_MODULES = 4
      var QR_MAX_SIDE_PX = 480

      /**
       * 把二维码画到 canvas 上。
       *
       * ★ 内容**只**取 POST /mobile/pair/code 返回的 qrPayload 原文 ✓ ——
       *   页面**绝不**自己拼 dshmobile://pair?d=... ✗：拼错一个字符，
       *   手机那边的 parseLink 就解析不了 ✓，而页面上二维码照样好看 ✓
       *   （本项目最怕这种"看着都对"的失败 ✗）。
       *
       * 为什么是 canvas 而不是内联 SVG（二选一 ✓，选它 ✓）：
       *   1. 每个模块 = **整数个像素** ✓：自己算 scale、不依赖路径/字体的抗锯齿 ✓，
       *      73×73 这种密度下 SVG 很容易出现"模块宽窄不一"的视觉噪声 ✓；
       *   2. 静区与白底**烘进位图** ✓ ⇒ 暗色主题吃不掉它 ✓
       *      （靠 CSS 留白在 prefers-color-scheme: dark 下会变成深色边框 ✗ ⇒ 扫不出来 ✗）；
       *   3. 73×73 = 5329 个模块：SVG 要么 2700 多个 rect 节点 ✓ 要么 ~80 KB 路径串 ✓，
       *      而 canvas 只多一个元素 ✓、DOM 不膨胀 ✓。
       *   代价是"位图放大要显式声明 image-rendering: pixelated" ✓ —— 已在 CSS 里写好 ✓。
       */
      function renderQr(payload) {
        var box = $('qr-box')
        var canvas = $('qr')
        try {
          if (!payload) throw new Error('接口没有返回 qrPayload')
          var qr = qrcode(0, QR_ERROR_CORRECTION)
          qr.addData(payload)
          qr.make()
          var count = qr.getModuleCount()
          var total = count + QR_QUIET_MODULES * 2
          // 每模块多少像素：取"能塞进内容区"的最大整数 ✓（整数 ⇒ 模块等宽、放大不糊 ✓）
          var available = Math.min(box.clientWidth || 420, QR_MAX_SIDE_PX)
          var scale = Math.floor(available / total)
          if (scale < 2) scale = 2
          if (scale > 8) scale = 8
          var side = total * scale
          canvas.width = side
          canvas.height = side
          canvas.style.width = side + 'px'
          var context = canvas.getContext('2d')
          if (!context) throw new Error('浏览器不支持 canvas 2d')
          // ★ 先铺满纯白底（含静区）✓：深色主题下静区同样是白的 ✓
          context.fillStyle = '#ffffff'
          context.fillRect(0, 0, side, side)
          // ★ 再画纯黑模块 ✓：黑白高对比，**不用**任何主题色 ✗
          context.fillStyle = '#000000'
          for (var row = 0; row < count; row++) {
            for (var col = 0; col < count; col++) {
              if (qr.isDark(row, col)) {
                context.fillRect((col + QR_QUIET_MODULES) * scale, (row + QR_QUIET_MODULES) * scale, scale, scale)
              }
            }
          }
          text('qr-placeholder', '')
          show('qr-placeholder', false)
          show('qr', true)
          text('qr-note', '用手机相机／壳内「扫码配对」扫这张码（' + count + '×' + count + ' 模块）')
        } catch (error) {
          // ★ 画不出来就明说 ✓，绝不把一张半成品或空洞留在屏幕上 ✗
          clearQr('二维码生成失败：' + (error && error.message ? error.message : error))
        }
      }

      /**
       * 把二维码从屏幕上撤掉，并给一句明确文案 ✓（过期/失败时用 ✓）。
       * 连位图一起丢掉（width/height = 0）✓：绝不留一张过期的码在那儿 ✗。
       */
      function clearQr(message) {
        var canvas = $('qr')
        var context = canvas.getContext('2d')
        if (context) context.clearRect(0, 0, canvas.width, canvas.height)
        canvas.width = 0
        canvas.height = 0
        show('qr', false)
        text('qr-placeholder', message)
        show('qr-placeholder', true)
        text('qr-note', '')
      }

      /** 配对码到期就把二维码撤掉 ✓（由 refreshConsole 每 1.5 秒顺带检查 ✓）。 */
      function checkPairingExpiry() {
        if (state.expiresAt === null) return
        if (Date.now() < state.expiresAt) return
        var at = new Date(state.expiresAt).toLocaleTimeString()
        state.expiresAt = null
        clearQr('二维码已过期（有效期至 ' + at + '）——请重新点「生成配对码」')
        text('expires', '已过期（' + at + '），请重新生成')
      }


      /**
       * 复制配对链接。
       *
       * 为什么不能只依赖 navigator.clipboard：该 API **只在安全上下文可用**
       * （HTTPS 或 localhost）。本页在局域网里是普通 HTTP，因此
       * navigator.clipboard 是 undefined——按钮点了完全没反应，
       * 且不报错、不提示，看起来就像"按钮坏了"。
       *
       * 因此这里按可靠性降级：
       *   1) navigator.clipboard（安全上下文）
       *   2) 选中 textarea + document.execCommand('copy')（旧 API，但在 HTTP 下可用）
       *   3) 仅选中文本，并明确提示用户手动复制（Ctrl/Cmd+C）
       */
      function copyPayload() {
        var field = $('payload')
        var value = field.value
        if (!value) {
          text('copy-ok', '请先生成配对码')
          return
        }

        function selectOnly() {
          field.focus()
          field.select()
        }

        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(value).then(
            function () { text('copy-ok', '已复制') },
            function () { fallback() },
          )
          return
        }
        fallback()

        function fallback() {
          selectOnly()
          var copied = false
          try {
            copied = document.execCommand('copy')
          } catch (error) {
            copied = false
          }
          text('copy-ok', copied ? '已复制' : '已选中，请按 Ctrl/Cmd+C 复制')
        }
      }

      async function generatePairing() {
        text('fatal', '')
        try {
          var created = await api('/mobile/pair/code', { method: 'POST' })
          state.code = created.ticket.code
          var expiresAt = Date.parse(created.expiresAt)
          state.expiresAt = isNaN(expiresAt) ? null : expiresAt
          text('code', created.ticket.code)
          $('payload').value = created.qrPayload
          // 手机地址由**宿主**给出（manifest.phoneBaseUrl）。页面不猜端口：
          // 手机侧必须 HTTPS（普通 HTTP 页面不是安全上下文，crypto.subtle 不存在），
          // 而 HTTPS 端口与明文端口不同，猜错会让用户照着一个连不上的地址去开。
          text('phone-url', state.phoneBaseUrl || '（宿主未配置手机地址，检查安装参数 --phone-base-url）')
          text('expires', '有效期至 ' + new Date(created.expiresAt).toLocaleTimeString())
          // ★ 先显示再画：renderQr 要量内容区宽度来定每模块像素 ✓
          show('pairing', true)
          // ★ 每次「生成配对码」都重画 ✓：新票据 ⇒ 新 qrPayload ⇒ 新二维码 ✓
          renderQr(created.qrPayload)
          startPolling()
        } catch (error) {
          var message = String(error && error.message ? error.message : error)
          text('fatal', message)
          // ★ 生成失败 ⇒ 不把上一张码留在屏幕上冒充"本次结果" ✗
          //   （兜底用的 6 位数字与链接不删 ✓，但二维码这一块要明说 ✗）
          state.expiresAt = null
          clearQr('生成配对码失败：' + message + '（可重试；下面的链接仍可兜底）')
        }
      }

      function startPolling() {
        if (state.timer !== null) clearInterval(state.timer)
        state.timer = setInterval(refreshConsole, 1500)
        refreshConsole()
      }

      async function refreshConsole() {
        // ★ 过期检查放在 try 之前：就算下面两个管理端点一起失败，
        //   过期二维码也必须被撤掉 ✓（别留一张过期的码在那儿 ✗）
        checkPairingExpiry()
        try {
          var pending = await api('/mobile/pair/pending')
          renderPending(pending.pairings || [])
          var devices = await api('/mobile/devices')
          renderDevices(devices.devices || [], devices.connected || 0)
        } catch (error) {
          text('fatal', String(error && error.message ? error.message : error))
        }
      }

      function renderPending(rows) {
        var waiting = rows.filter(function (row) { return row.state === 'claimed' || row.state === 'open' })
        var container = $('pending')
        container.innerHTML = ''
        if (waiting.length === 0) {
          container.className = 'muted'
          container.textContent = '（暂无待确认设备）'
          return
        }
        container.className = ''
        waiting.forEach(function (row) {
          var div = document.createElement('div')
          div.className = 'card'
          div.style.background = 'var(--bg)'
          var title = document.createElement('div')
          title.innerHTML = '<strong>' + escapeHtml(row.name || row.deviceId || '未知设备') + '</strong>'
          div.appendChild(title)
          if (row.model) {
            var model = document.createElement('div')
            model.className = 'muted'
            model.textContent = row.model + (row.platform ? ' · ' + row.platform : '')
            div.appendChild(model)
          }
          if (row.fingerprint) {
            var label = document.createElement('p')
            label.className = 'muted'
            label.style.margin = '10px 0 4px'
            label.textContent = '设备指纹（与手机比对）'
            div.appendChild(label)
            var fp = document.createElement('div')
            fp.className = 'fp mono'
            fp.textContent = formatFingerprint(row.fingerprint)
            div.appendChild(fp)
          }
          var actions = document.createElement('div')
          actions.className = 'row'
          actions.style.marginTop = '12px'
          /**
           * ★ state === 'open' = **手机还没提交指纹** ✓（claim 还没到 ✓）。
           *   这时既没有 deviceId 也没有可核对的指纹 ⇒ 原先照样渲染出「允许此设备」✗，
           *   点下去必然 404（confirmPairing 匹配不上 ✓），而用户看到的是
           *   "点了允许、什么都没发生" ✗。⇒ 这一态**不给按钮** ✓，直接说清楚在等什么 ✓。
           */
          if (row.deviceId === undefined || row.fingerprint === undefined) {
            var waitingNote = document.createElement('p')
            waitingNote.className = 'muted'
            waitingNote.style.margin = '10px 0 0'
            waitingNote.textContent = '等待手机提交指纹…（手机扫码后这里会出现指纹供你比对）'
            div.appendChild(waitingNote)
            container.appendChild(div)
            return
          }
          var allow = document.createElement('button')
          allow.className = 'primary'
          allow.textContent = '允许此设备'
          allow.onclick = function () { confirmPairing(row.code, row.deviceId, true) }
          var deny = document.createElement('button')
          deny.className = 'danger'
          deny.textContent = '拒绝'
          deny.onclick = function () { confirmPairing(row.code, row.deviceId, false) }
          actions.appendChild(allow); actions.appendChild(deny)
          div.appendChild(actions)
          container.appendChild(div)
        })
      }

      /**
       * 电脑端确认 / 拒绝一台设备。
       *
       * ★ 两种结局都**必须看得见** ✗（本轮）：
       *   · 成功：设备这一刻就被登记成「已授权」✓（见宿主 confirmPairing ✓）⇒
       *     不给一句话的话，用户看到的是"待确认那一行消失了、别的什么都没变"✗
       *     （真实反馈："允许以后不出现新的已授权设备"✓）；
       *   · 失败（多半是 404：code / deviceId 对不上 ✓）：那就是"点了允许却没生效"✗，
       *     必须把这个原因摆在屏幕上 ✓，并告诉用户下一步做什么 ✓。
       */
      async function confirmPairing(code, deviceId, approve) {
        try {
          await api('/mobile/pair/confirm', { method: 'POST', body: JSON.stringify({ code: code, deviceId: deviceId, approve: approve }) })
          text('fatal', '')
          text('pairNote', approve ? '已允许该设备 ✓ 已登记为「已授权」（见下方列表）——手机随后会自动连上' : '已拒绝该设备 ✓')
          refreshConsole()
        } catch (error) {
          text('fatal', '配对确认失败：' + String(error && error.message ? error.message : error) + '（请在电脑上重新生成配对码，再让手机扫一次）')
        }
      }

      function renderDevices(rows, connected) {
        var container = $('devices')
        container.innerHTML = ''
        if (rows.length === 0) {
          container.className = 'muted'
          container.textContent = '（无）'
          return
        }
        container.className = ''
        var summary = document.createElement('p')
        summary.className = 'muted'
        summary.textContent = '共 ' + rows.length + ' 台，当前在线 ' + connected + ' 台'
        container.appendChild(summary)
        rows.forEach(function (row) {
          var div = document.createElement('div')
          div.className = 'dev'
          var left = document.createElement('div')
          var name = document.createElement('div')
          name.innerHTML = '<strong>' + escapeHtml(row.name) + '</strong>'
          left.appendChild(name)
          var meta = document.createElement('div')
          meta.className = 'muted'
          meta.style.fontSize = '12px'
          var caps = row.capabilities || {}
          var ability = []
          if (caps.fsRead) ability.push('只读')
          if (caps.fsWrite) ability.push('可写')
          if (caps.fsShell) ability.push('可执行')
          meta.textContent = row.authorization + (ability.length ? ' · ' + ability.join('/') : '')
          left.appendChild(meta)
          var fp = document.createElement('div')
          fp.className = 'mono muted'
          fp.style.fontSize = '12px'
          fp.textContent = formatFingerprint(row.fingerprint)
          left.appendChild(fp)
          div.appendChild(left)

          var actions = document.createElement('div')
          actions.className = 'row'
          if (row.authorization !== 'revoked') {
            var write = document.createElement('button')
            write.textContent = caps.fsWrite ? '收回写权限' : '授予写权限'
            write.onclick = function () { updateDevice(row.deviceId, { capabilities: { fsWrite: !caps.fsWrite } }) }
            actions.appendChild(write)
            var revoke = document.createElement('button')
            revoke.className = 'danger'
            revoke.textContent = '撤销'
            revoke.onclick = function () { revokeDevice(row.deviceId) }
            actions.appendChild(revoke)
          } else {
            var badge = document.createElement('span')
            badge.className = 'badge danger'
            badge.textContent = '已撤销'
            actions.appendChild(badge)
          }
          div.appendChild(actions)
          container.appendChild(div)
        })
      }

      async function updateDevice(deviceId, update) {
        try {
          await api('/mobile/devices/update', { method: 'POST', body: JSON.stringify({ deviceId: deviceId, update: update }) })
          refreshConsole()
        } catch (error) {
          text('fatal', String(error && error.message ? error.message : error))
        }
      }

      async function revokeDevice(deviceId) {
        if (!confirm('撤销后该设备会立即断开，且必须重新配对。确定吗？')) return
        try {
          await api('/mobile/devices/revoke', { method: 'POST', body: JSON.stringify({ deviceId: deviceId }) })
          refreshConsole()
        } catch (error) {
          text('fatal', String(error && error.message ? error.message : error))
        }
      }

      /**
       * 找出"电脑控制台"的地址。
       *
       * 背景：DSH 只绑 loopback，手机走的是本机代理端口，因此两个地址的端口不同：
       *   电脑控制台 = http://127.0.0.1:<DSH端口>/mobile
       *   手机入口   = http://<局域网IP>:<代理端口>/mobile
       * 手机无法访问前者，但它需要知道前者是什么，才能正确引导用户。
       *
       * 探测方法：逐个尝试候选地址上的管理端点（只有电脑本机能得到 200）。
       * 候选来自常见约定：与当前端口相同（若当前就是 DSH 端口），
       * 以及 3080（默认端口）。全部失败时不误导用户，只提示"电脑上的本机地址"。
       */
      async function probeDesktopUrl() {
        var host = location.hostname
        var port = location.port || '80'
        var candidates = []
        // 同端口（当手机上访问的恰好就是 DSH 端口时成立）
        candidates.push('http://127.0.0.1:' + port)
        // 常见默认端口
        if (port !== '3080') candidates.push('http://127.0.0.1:3080')
        for (var i = 0; i < candidates.length; i++) {
          try {
            var response = await fetch(candidates[i] + '/mobile/pair/pending', { method: 'GET' })
            if (response.ok) return candidates[i] + '/mobile'
          } catch (error) {
            /* 跨源失败或不可达：继续下一个 */
          }
        }
        return undefined
      }

      // ───────────────────────── 启动 ─────────────────────────

      async function boot() {
        // 手机应访问的基地址（HTTPS）由宿主给出，页面不猜端口。
        // 必须在**所有分支之前**读取：早先把它放在"已配对"分支里，
        // 结果电脑端（尚未配对）拿不到值，提示变成"宿主未配置手机地址"。
        try {
          var manifestForPhoneUrl = await api('/mobile/manifest')
          state.phoneBaseUrl = manifestForPhoneUrl.phoneBaseUrl || null
          // ★ C2：本机 CA 指纹（manifest.tls.caFingerprint ✓ —— 由宿主 tls.status() 给出 ✓）。
          //   它与配对票据里那个 caFingerprint 是**同一个值**（见 createPairing ✓），
          //   所以电脑屏幕上这一串正好可以当"手机票据里那一串"的参照物 ✓。
          state.caFingerprint = manifestForPhoneUrl.tls && manifestForPhoneUrl.tls.caFingerprint
            ? manifestForPhoneUrl.tls.caFingerprint
            : null
        } catch (error) {
          state.phoneBaseUrl = null
          state.caFingerprint = null
        }

        // 判定自己是电脑还是手机：能访问 loopback 管理端点的是电脑。
        var local = false
        try {
          await api('/mobile/pair/pending')
          local = true
        } catch (error) {
          local = false
        }

        if (local) {
          text('subtitle', '配对控制台（本页在电脑上打开）')
          show('desktop', true)
          $('gen').onclick = generatePairing
          $('refresh').onclick = function () {
            text('fatal', '')
            refreshConsole()
          }
          $('copy').onclick = copyPayload
          showCaFingerprint()
          refreshConsole()
        } else {
          text('subtitle', '在这台手机上接入电脑上的 DeepSeek Harness')
          show('phone', true)
          $('do-pair').onclick = doPair
          $('scan-qr').onclick = scanQr
          $('open-gui').onclick = openGui
          renderPhoneHosts()
          probeDesktopUrl().then(function (desktopUrl) {
            if (desktopUrl !== undefined) {
              text('desktop-url', desktopUrl)
              text('desktop-url-note', '（该地址只能在电脑本机打开，手机打不开——这是刻意的安全设计）')
            } else {
              text('desktop-url', '127.0.0.1:<DSH端口>/mobile')
              text('desktop-url-note', '请在电脑上用它自己的本机地址打开配对页（形如 http://127.0.0.1:3080/mobile）。')
            }
          })
          var stored = readStored()
          if (stored) {
            text('conn-state', '已配对')
            text('conn-detail', '主机指纹 ' + formatFingerprint(stored.pinnedHostFingerprint))
          }
          // ★ C2：把"这台电脑的 CA"与"壳记住了哪一台"摆在一起（见 renderCaTrust ✓）
          renderCaTrust()
        }
      }

      boot().catch(function (error) {
        text('fatal', String(error && error.message ? error.message : error))
      })
    </script>
  </body>
</html>
`
