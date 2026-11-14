/**
 * Build identity of the loaded client. Hashed asset file names make every deployment load fresh
 * files once `index.html` (served with `no-cache`) is fetched again; this check tells an already
 * open tab that a newer deployment is live so it can reload.
 */
export const BUILD_ID: string = (import.meta.env.VITE_BUILD_ID as string | undefined)?.trim() || 'dev';

/** Build part of a server version like `0.1.0+984c7eafba23`, or null. */
export function serverBuild(version: string | null | undefined): string | null {
  const plus = version?.indexOf('+') ?? -1;
  const build = plus >= 0 ? version!.slice(plus + 1).trim() : '';
  return build.length > 0 ? build : null;
}

/** True when the server runs a different build than this client (dev builds never report outdated). */
export function isOutdated(clientBuild: string, serverVersion: string | null | undefined): boolean {
  const server = serverBuild(serverVersion);
  if (!server || clientBuild === 'dev' || server === 'dev') return false;
  const n = Math.min(clientBuild.length, server.length);
  return n > 0 && clientBuild.slice(0, n).toLowerCase() !== server.slice(0, n).toLowerCase();
}

export const VERSION_CHECK_MS = 60_000;
