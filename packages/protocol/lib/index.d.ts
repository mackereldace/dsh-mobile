/**
 * @dsh-mobile/protocol 的公开入口。
 *
 * 三端（Node 宿主插件 / 浏览器客户端插件 / Flutter 外壳）只从这里导入，
 * 保证线协议定义唯一。Dart 端按 docs/protocol.md 与 test/vectors.json 手工镜像。
 */
export * from './wire.ts';
export * from './crypto.ts';
export * from './handshake.ts';
export * from './mux.ts';
//# sourceMappingURL=index.d.ts.map