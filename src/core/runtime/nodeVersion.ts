/**
 * Runtime guard for the supported Node.js line — package.json `engines: ">=22.13.0"`.
 *
 * Why: on Node 22.12.0 the native `argon2` binding (decision C3) crashes the process with a
 * segmentation fault (observed 2026-11-20), which surfaces as "Worker exited unexpectedly" in tests or
 * a silent server crash. Failing fast with a clear message is safer. The supported *line* (22 only vs
 * 22 + 24) is still open as OQ-110; this guard only enforces the existing minimum.
 */
export const MIN_NODE_VERSION = '22.13.0';

function parse(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  return [major, minor, patch];
}

export function isSupportedNode(version: string, minimum: string = MIN_NODE_VERSION): boolean {
  const actual = parse(version);
  const required = parse(minimum);
  for (let i = 0; i < 3; i += 1) {
    const a = actual[i] ?? 0;
    const r = required[i] ?? 0;
    if (a !== r) return a > r;
  }
  return true;
}

export function assertSupportedNode(version: string = process.versions.node): void {
  if (!isSupportedNode(version)) {
    throw new Error(
      `Node.js ${version} is not supported: ecommerce-api requires >= ${MIN_NODE_VERSION} (package.json engines). ` +
        'With nvm-windows run "nvm use 24.12.0" (or install 22.13+). Older Node crashes the native argon2 module.',
    );
  }
}
