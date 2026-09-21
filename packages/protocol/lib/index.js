/**
 * @dsh-mobile/protocol 的公开入口。
 *
 * 三端（Node 宿主插件 / 浏览器客户端插件 / Flutter 外壳）只从这里导入，
 * 保证线协议定义唯一。Dart 端按 docs/protocol.md 与 test/vectors.json 手工镜像。
 */
export * from "./wire.js";
export * from "./crypto.js";
export * from "./handshake.js";
export * from "./mux.js";
//# sourceMappingURL=index.js.map