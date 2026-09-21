/// dsh-mobile 外壳：主机档案模型与持久化。
///
/// 设计要点：
///  - 一个"主机档案"= 一台电脑的接入信息。手机可以保存多台，随时切换。
///  - 指纹（fingerprint）是**宿主身份公钥**的哈希，用于 TOFU 固定；
///    首次配对时由二维码带外提供，之后每次连接都校验。指纹变化必须让用户知情。
///  - 配对票据只在首次连接使用，连接成功后立即清除，不长期留在存储里。
library;

import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 一台电脑的接入档案。
class HostProfile {
  HostProfile({
    required this.id,
    required this.name,
    required this.baseUrl,
    required this.tunnelUrl,
    required this.fingerprint,
    this.pairingTicket,
    this.lastConnectedAt,
  });

  /// 稳定标识：用宿主指纹（同一台电脑重装 DSH 会换指纹，因此等于"换机"）。
  final String id;

  /// 用户可改的显示名。
  String name;

  /// 页面基地址，例如 `http://192.168.1.23:3080`。
  final String baseUrl;

  /// 隧道 WebSocket 地址，例如 `ws://192.168.1.23:3080/mobile/ws`。
  final String tunnelUrl;

  /// 宿主身份公钥指纹（hex，32 字符）。用于 TOFU 固定。
  final String fingerprint;

  /// 首次配对的票据；连接成功后清除。
  String? pairingTicket;

  /// 最近一次成功连接时间。
  DateTime? lastConnectedAt;

  /// 由宿主基地址推导隧道地址（http→ws、https→wss）。
  static String tunnelUrlFor(String baseUrl) {
    final uri = Uri.parse(baseUrl);
    final scheme = uri.scheme == 'https' ? 'wss' : 'ws';
    return '$scheme://${uri.authority}/mobile/ws';
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'baseUrl': baseUrl,
        'tunnelUrl': tunnelUrl,
        'fingerprint': fingerprint,
        if (pairingTicket != null) 'pairingTicket': pairingTicket,
        if (lastConnectedAt != null) 'lastConnectedAt': lastConnectedAt!.toIso8601String(),
      };

  static HostProfile fromJson(Map<String, dynamic> json) => HostProfile(
        id: json['id'] as String,
        name: json['name'] as String? ?? '未命名电脑',
        baseUrl: json['baseUrl'] as String,
        tunnelUrl: json['tunnelUrl'] as String,
        fingerprint: json['fingerprint'] as String,
        pairingTicket: json['pairingTicket'] as String?,
        lastConnectedAt: json['lastConnectedAt'] == null
            ? null
            : DateTime.tryParse(json['lastConnectedAt'] as String),
      );

  /// 指纹的人类可读形式：4 字符一组，便于与电脑屏幕上的值逐段比对。
  String get formattedFingerprint {
    final buffer = StringBuffer();
    for (var i = 0; i < fingerprint.length; i += 4) {
      if (i > 0) buffer.write('-');
      buffer.write(fingerprint.substring(i, (i + 4).clamp(0, fingerprint.length)));
    }
    return buffer.toString().toUpperCase();
  }
}

/// 档案存储。
///
/// 分两处存：
///  - **非敏感字段**（名称、地址、指纹）放 SharedPreferences，便于用户在设置里查看与备份；
///  - **配对票据**放安全存储（Android Keystore / iOS Keychain），因为它是一次性凭证。
class ProfileStore {
  ProfileStore({FlutterSecureStorage? secureStorage})
      : _secure = secureStorage ?? const FlutterSecureStorage();

  static const _profilesKey = 'dsh-mobile.profiles';
  static const _ticketPrefix = 'dsh-mobile.ticket.';

  final FlutterSecureStorage _secure;

  /// 读取全部档案。
  Future<List<HostProfile>> load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_profilesKey);
    if (raw == null) return [];
    final decoded = jsonDecode(raw) as List<dynamic>;
    final profiles = <HostProfile>[];
    for (final item in decoded) {
      final profile = HostProfile.fromJson(item as Map<String, dynamic>);
      // 票据单独从安全存储取，缺失时不影响档案可用（只是需要重新配对）
      profile.pairingTicket = await _secure.read(key: '$_ticketPrefix${profile.id}');
      profiles.add(profile);
    }
    return profiles;
  }

  /// 保存/更新一个档案。
  Future<void> save(HostProfile profile) async {
    final profiles = await load();
    final index = profiles.indexWhere((p) => p.id == profile.id);
    if (index >= 0) {
      profiles[index] = profile;
    } else {
      profiles.add(profile);
    }
    await _persist(profiles);
    final ticket = profile.pairingTicket;
    if (ticket == null) {
      await _secure.delete(key: '$_ticketPrefix${profile.id}');
    } else {
      await _secure.write(key: '$_ticketPrefix${profile.id}', value: ticket);
    }
  }

  /// 删除一个档案（同时清除其票据）。
  Future<void> remove(String id) async {
    final profiles = await load();
    profiles.removeWhere((p) => p.id == id);
    await _persist(profiles);
    await _secure.delete(key: '$_ticketPrefix$id');
  }

  /// 首次连接成功后清除配对票据（票据是一次性的，长期留存没有意义且有风险）。
  Future<void> clearTicket(HostProfile profile) async {
    profile.pairingTicket = null;
    await save(profile);
  }

  Future<void> _persist(List<HostProfile> profiles) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      _profilesKey,
      jsonEncode(profiles.map((p) => p.toJson()).toList()),
    );
  }
}

/// 从二维码内容解析配对信息。
///
/// 二维码由电脑端生成，内容形如：
/// `dshmobile://pair?d=<base64url(JSON(PairingTicket))>`
/// 其中 JSON 含 hostId / hostFingerprint / code / ticket / endpoints / expiresAt。
class PairingQr {
  PairingQr({
    required this.hostId,
    required this.hostFingerprint,
    required this.code,
    required this.ticket,
    required this.endpoints,
    this.expiresAt,
  });

  final String hostId;
  final String hostFingerprint;

  /// 6 位配对码：用户在电脑端屏幕上比对，确认自己扫的是同一台机器。
  final String code;
  final String ticket;
  final List<String> endpoints;
  final DateTime? expiresAt;

  bool get isExpired => expiresAt != null && DateTime.now().isAfter(expiresAt!);

  /// 解析二维码文本；格式不符时抛出 [FormatException]（调用方应提示用户"这不是配对码"）。
  static PairingQr parse(String text) {
    final uri = Uri.tryParse(text.trim());
    if (uri == null || uri.scheme != 'dshmobile') {
      throw const FormatException('这不是 dsh-mobile 的配对码');
    }
    final payload = uri.queryParameters['d'];
    if (payload == null) {
      throw const FormatException('配对码缺少数据字段');
    }
    final normalized = payload.replaceAll('-', '+').replaceAll('_', '/');
    final padded = normalized.padRight((normalized.length / 4).ceil() * 4, '=');
    final decoded = jsonDecode(utf8.decode(base64.decode(padded))) as Map<String, dynamic>;

    final fingerprint = decoded['hostFingerprint'] as String?;
    final ticket = decoded['ticket'] as String?;
    if (fingerprint == null || ticket == null) {
      throw const FormatException('配对码内容不完整');
    }
    final endpoints = (decoded['endpoints'] as List<dynamic>? ?? const [])
        .map((e) => e as String)
        .toList(growable: false);
    return PairingQr(
      hostId: decoded['hostId'] as String? ?? 'unknown',
      hostFingerprint: fingerprint,
      code: decoded['code'] as String? ?? '',
      ticket: ticket,
      endpoints: endpoints,
      expiresAt: decoded['expiresAt'] == null ? null : DateTime.tryParse(decoded['expiresAt'] as String),
    );
  }

  /// 从候选地址里挑一个可用基地址。
  ///
  /// 优先 IPv4 局域网地址（手机与电脑同网段时最稳），其次 IPv6，最后回退到原地址。
  String preferredBaseUrl(String fallback) {
    if (endpoints.isEmpty) return fallback;
    final ipv4 = endpoints.where((e) => RegExp(r'^https?://\d+\.\d+\.\d+\.\d+').hasMatch(e)).toList();
    if (ipv4.isNotEmpty) return ipv4.first;
    return endpoints.first;
  }
}
