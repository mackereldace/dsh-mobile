/// dsh-mobile 外壳主界面。
///
/// 架构（对应工程纲要 §5.1 B 线）：
///   手机端**不重写 DSH 的 UI**，而是用 WebView 加载电脑端 DSH 前端，
///   并在页面启动前注入连接配置，让 `boot.js` 把全部业务流量接进端到端加密隧道。
///
/// 外壳自己只负责四件事：
///   1. 主机档案与切换（多台电脑）；
///   2. 扫码配对（带外校验宿主指纹，防中间人）；
///   3. 在页面启动前注入 `__DSH_MOBILE__`（连接配置）；
///   4. 原生能力桥（后续里程碑：文件选择、通知、生物识别）。
library;

import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'host_profile.dart';
import 'pairing_page.dart';

void main() {
  runApp(const DshMobileApp());
}

/// 应用根。
class DshMobileApp extends StatelessWidget {
  const DshMobileApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'DSH Mobile',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF4D6BFE)),
        useMaterial3: true,
      ),
      home: const HostListPage(),
    );
  }
}

/// 主机列表：手机能连的电脑都列在这里。
class HostListPage extends StatefulWidget {
  const HostListPage({super.key});

  @override
  State<HostListPage> createState() => _HostListPageState();
}

class _HostListPageState extends State<HostListPage> {
  final _store = ProfileStore();
  List<HostProfile> _profiles = const [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    final profiles = await _store.load();
    if (!mounted) return;
    setState(() {
      _profiles = profiles;
      _loading = false;
    });
  }

  Future<void> _startPairing() async {
    final paired = await Navigator.of(context).push<HostProfile>(
      MaterialPageRoute(builder: (_) => const PairingPage()),
    );
    if (paired == null) return;
    await _store.save(paired);
    await _refresh();
    if (!mounted) return;
    await _openHost(paired);
  }

  Future<void> _openHost(HostProfile profile) async {
    await Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => HostWebViewPage(profile: profile, store: _store)),
    );
    await _refresh();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('我的电脑'),
        actions: [
          IconButton(
            onPressed: _loading ? null : _refresh,
            icon: const Icon(Icons.refresh),
            tooltip: '刷新',
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _profiles.isEmpty
              ? _EmptyState(onPair: _startPairing)
              : ListView.separated(
                  itemCount: _profiles.length,
                  separatorBuilder: (_, _) => const Divider(height: 1),
                  itemBuilder: (context, index) {
                    final profile = _profiles[index];
                    return ListTile(
                      leading: const CircleAvatar(child: Icon(Icons.computer)),
                      title: Text(profile.name),
                      subtitle: Text(
                        '${profile.baseUrl}\n指纹 ${profile.formattedFingerprint}',
                        style: const TextStyle(fontSize: 12),
                      ),
                      isThreeLine: true,
                      trailing: IconButton(
                        icon: const Icon(Icons.delete_outline),
                        tooltip: '移除',
                        onPressed: () async {
                          final confirmed = await showDialog<bool>(
                            context: context,
                            builder: (ctx) => AlertDialog(
                              title: const Text('移除这台电脑？'),
                              content: const Text('移除后需要重新扫码配对。电脑端的授权不会自动撤销，'
                                  '如需彻底断开请在电脑端撤销该设备。'),
                              actions: [
                                TextButton(
                                  onPressed: () => Navigator.pop(ctx, false),
                                  child: const Text('取消'),
                                ),
                                FilledButton(
                                  onPressed: () => Navigator.pop(ctx, true),
                                  child: const Text('移除'),
                                ),
                              ],
                            ),
                          );
                          if (confirmed == true) {
                            await _store.remove(profile.id);
                            await _refresh();
                          }
                        },
                      ),
                      onTap: () => _openHost(profile),
                    );
                  },
                ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _startPairing,
        icon: const Icon(Icons.qr_code_scanner),
        label: const Text('扫码配对'),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.onPair});

  final VoidCallback onPair;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.phonelink_setup, size: 72),
            const SizedBox(height: 16),
            Text('还没有连接过电脑', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            const Text(
              '在电脑上运行 dsh web 并生成配对码，然后用手机扫码。\n'
              '配对时请比对电脑屏幕与手机上显示的指纹是否一致——这一步是防中间人的关键。',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13),
            ),
          ],
        ),
      ),
    );
  }
}

/// WebView 承载页：加载电脑端 DSH 前端并注入连接配置。
class HostWebViewPage extends StatefulWidget {
  const HostWebViewPage({super.key, required this.profile, required this.store});

  final HostProfile profile;
  final ProfileStore store;

  @override
  State<HostWebViewPage> createState() => _HostWebViewPageState();
}

class _HostWebViewPageState extends State<HostWebViewPage> {
  late final WebViewController _controller;
  bool _loaded = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      // 关键：在页面任何脚本执行**之前**注入配置。
      // boot.js 由宿主通过 tapIndex 注入 index.html，会读取这个全局对象；
      // 若这里晚了，boot.js 会认为"尚未配对"而不启用隧道。
      ..addJavaScriptChannel('DshNative', onMessageReceived: (message) {
        debugPrint('[native] $message');
      })
      ..setNavigationDelegate(
        NavigationDelegate(
          onPageStarted: (url) => _injectConfig(),
          onPageFinished: (url) {
            if (!mounted) return;
            setState(() => _loaded = true);
          },
          onWebResourceError: (error) {
            if (!mounted) return;
            setState(() {
              _error = '无法加载（${widget.profile.baseUrl}）\n${error.description}\n\n'
                  '请确认：手机与电脑在同一局域网、电脑端 dsh web 正在运行、'
                  '电脑端已用 --host 0.0.0.0 并加入 --trusted-host。';
            });
          },
        ),
      );
    _load();
  }

  void _load() {
    // 票据通过注入传递（而非 URL），避免留在浏览历史与日志里
    _controller.loadRequest(Uri.parse(widget.profile.baseUrl));
  }

  /// 注入连接配置。
  ///
  /// 为什么在这里注入是可靠的：Boot 脚本由宿主插进 index.html 的 `<head>`，
  /// 它先于应用 bundle 执行；而 `onPageStarted` 早于该脚本的执行时机。
  void _injectConfig() {
    final profile = widget.profile;
    final ticket = profile.pairingTicket;
    final config = '''
(function () {
  window.__DSH_MOBILE__ = {
    hostBaseUrl: ${_js(profile.baseUrl)},
    tunnelUrl: ${_js(profile.tunnelUrl)},
    hostFingerprint: ${_js(profile.fingerprint)},
    pairingTicket: ${ticket == null ? 'undefined' : _js(ticket)},
    shell: 'flutter',
    capabilities: { biometric: true, scanner: true, notify: true, keystore: true }
  };
})();
''';
    _controller.runJavaScript(config);
  }

  /// 把 Dart 字符串安全地嵌入 JS 字面量。
  String _js(String value) =>
      '"${value.replaceAll(r'\', r'\\').replaceAll('"', r'\"').replaceAll('\n', r'\n')}"';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.profile.name),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: '重新加载',
            onPressed: () => _controller.reload(),
          ),
        ],
      ),
      body: Stack(
        children: [
          WebViewWidget(controller: _controller),
          if (!_loaded)
            const ColoredBox(
              color: Colors.black12,
              child: Center(child: CircularProgressIndicator()),
            ),
          if (_error != null)
            ColoredBox(
              color: Theme.of(context).colorScheme.surface,
              child: Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      const Icon(Icons.error_outline, size: 48),
                      const SizedBox(height: 12),
                      Text(_error!, textAlign: TextAlign.center),
                      const SizedBox(height: 16),
                      FilledButton(
                        onPressed: () {
                          setState(() => _error = null);
                          _controller.reload();
                        },
                        child: const Text('重试'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
