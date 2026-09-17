/**
 * 文件读取层的共享错误类型。
 *
 * 放在独立模块里，避免 excel-reader 与 word-reader 互相依赖，
 * 也保证 instanceof 判断在整个应用中是同一个类。
 */

export class ReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadError';
  }
}
