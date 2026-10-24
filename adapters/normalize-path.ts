/**
 * 相对路径规范化。
 *
 * manifest 中的 `entry.path` 是**跨平台标识符**，不携带平台信息，因此必须统一为
 * POSIX 风格（正斜杠）。`src/lib/managed-path.ts` 的 `managedPaths` 白名单按正斜杠
 * 锚定，生产方不规范化就会在 Windows 上全面失配，导致安装静默中止。
 *
 * 这里选择「产出方规范化」而非「放宽消费者正则」：后者会削弱白名单的路径穿越防护。
 */
export function toPosixRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}
