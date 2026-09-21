/// 扫码配对页。
///
/// 配对流程（对应工程纲要 §4/§7）：
///   1. 用户在电脑端生成配对码（二维码 + 6 位数字）；
///   2. 手机扫码，解析出宿主地址、宿主指纹、一次性票据；
///   3. **手机显示指纹，请用户与电脑屏幕逐段比对**——这是防中间人的带外校验点；
///   4. 用户确认后写入档案，首次连接携带票据，电脑端仍需人工确认设备指纹。
///
/// 为什么第 3 步不能省：
///   二维码本身是带外信道（屏幕 → 摄像头），攻击者无法在不接触电脑的情况下篡改它。
///   而如果省略这一步，手机就只能"信任第一次连上的那台机器"，中间人可在首次连接时顶替。
library;

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'host_profile.dart';

class PairingPage extends StatefulWidget {
  const PairingPage({super.key});

  @override
  State<PairingPage> createState() => _PairingPageState();
}

class _PairingPageState extends State<PairingPage> {
  final _scanner = MobileScannerController(detectionSpeed: DetectionSpeed.noDuplicates);
  final _manualController = TextEditingController();

  PairingQr? _pending;
  String? _error;
  bool _scanning = true;

  @override
  void dispose() {
    _scanner.dispose();
    _manualController.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (!_scanning) return;
    for (final barcode in capture.barcodes) {
      final raw = barcode.rawValue;
      if (raw == null) continue;
      try {
        final qr = PairingQr.parse(raw);
        _acceptQr(qr);
        return;
      } on FormatException catch (error) {
        // 扫到别的二维码是常见情况：提示但不中断扫码
        setState(() => _error = error.message);
      }
    }
  }

  void _acceptQr(PairingQr qr) {
    if (qr.isExpired) {
      setState(() {
        _error = '这个配对码已过期，请在电脑端重新生成。';
        _pending = null;
      });
      return;
    }
    setState(() {
      _pending = qr;
      _error = null;
      _scanning = false;
    });
    _scanner.stop();
  }

  void _confirm() {
    final qr = _pending;
    if (qr == null) return;
    final baseUrl = qr.preferredBaseUrl('');
    if (baseUrl.isEmpty) {
      setState(() => _error = '配对码里没有可用的电脑地址。');
      return;
    }
    final profile = HostProfile(
      id: qr.hostFingerprint,
      name: '电脑 ${qr.code.isEmpty ? qr.hostId : qr.code}',
      baseUrl: baseUrl,
      tunnelUrl: HostProfile.tunnelUrlFor(baseUrl),
      fingerprint: qr.hostFingerprint,
      pairingTicket: qr.ticket,
    );
    Navigator.of(context).pop(profile);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('扫码配对'),
        actions: [
          if (_pending == null)
            IconButton(
              tooltip: '手输配对码',
              icon: const Icon(Icons.keyboard),
              onPressed: _enterManually,
            ),
        ],
      ),
      body: _pending == null ? _buildScanner() : _buildConfirm(_pending!),
    );
  }

  /// 扫码视图。
  Widget _buildScanner() {
    return Column(
      children: [
        Expanded(
          child: Stack(
            children: [
              MobileScanner(controller: _scanner, onDetect: _onDetect),
              // 取景框：提示用户把二维码放进框内
              Center(
                child: Container(
                  width: 240,
                  height: 240,
                  decoration: BoxDecoration(
                    border: Border.all(color: Colors.white70, width: 3),
                    borderRadius: BorderRadius.circular(16),
                  ),
                ),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text(
                '在电脑上运行 dsh web，生成配对二维码，然后用手机对准它。',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 13),
              ),
              if (_error != null) ...[
                const SizedBox(height: 8),
                Text(
                  _error!,
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 13),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }

  /// 确认视图：**这一步是防中间人的关键**，因此把指纹放在最显眼的位置。
  Widget _buildConfirm(PairingQr qr) {
    final formatted = _formatFingerprint(qr.hostFingerprint);
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Icon(Icons.verified_user, size: 56, color: Theme.of(context).colorScheme.primary),
        const SizedBox(height: 12),
        Text('请核对指纹', style: Theme.of(context).textTheme.titleLarge, textAlign: TextAlign.center),
        const SizedBox(height: 8),
        const Text(
          '电脑屏幕上的配对码旁边会显示同一串指纹。\n逐段比对一致后再继续——不一致说明扫描到的不是你的电脑。',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 13),
        ),
        const SizedBox(height: 20),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              children: [
                Text('电脑指纹', style: Theme.of(context).textTheme.labelMedium),
                const SizedBox(height: 8),
                SelectableText(
                  formatted,
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 15, height: 1.5),
                ),
                if (qr.code.isNotEmpty) ...[
                  const Divider(height: 32),
                  Text('配对码', style: Theme.of(context).textTheme.labelMedium),
                  const SizedBox(height: 4),
                  Text(
                    qr.code,
                    style: const TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 28,
                      letterSpacing: 6,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
        const SizedBox(height: 8),
        Text(
          '连接地址：${qr.preferredBaseUrl('')}',
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 12),
        ),
        if (_error != null) ...[
          const SizedBox(height: 8),
          Text(
            _error!,
            textAlign: TextAlign.center,
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
        ],
        const SizedBox(height: 20),
        FilledButton.icon(
          onPressed: _confirm,
          icon: const Icon(Icons.check),
          label: const Text('指纹一致，继续'),
        ),
        const SizedBox(height: 8),
        OutlinedButton(
          onPressed: () {
            setState(() {
              _pending = null;
              _error = null;
              _scanning = true;
            });
            _scanner.start();
          },
          child: const Text('重新扫描'),
        ),
      ],
    );
  }

  /// 手输配对码：没有相机权限时的降级路径。
  Future<void> _enterManually() async {
    final text = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('粘贴配对链接'),
        content: TextField(
          controller: _manualController,
          maxLines: 3,
          decoration: const InputDecoration(
            hintText: 'dshmobile://pair?d=...',
            helperText: '从电脑端复制配对链接后粘贴到这里',
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, _manualController.text),
            child: const Text('解析'),
          ),
        ],
      ),
    );
    if (text == null || text.trim().isEmpty) return;
    try {
      _acceptQr(PairingQr.parse(text));
    } on FormatException catch (error) {
      setState(() => _error = error.message);
    }
  }

  String _formatFingerprint(String hex) {
    final buffer = StringBuffer();
    for (var i = 0; i < hex.length; i += 4) {
      if (i > 0) buffer.write('-');
      buffer.write(hex.substring(i, (i + 4).clamp(0, hex.length)));
    }
    return buffer.toString().toUpperCase();
  }
}
