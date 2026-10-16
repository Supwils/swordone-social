const UNPARSEABLE = '(unparseable DATABASE_URL)';

/**
 * Name the database a connection string points at, without its credentials.
 * Operator scripts print this before writing, so a wrong DATABASE_URL is seen
 * before it is used.
 */
export function describeDbTarget(uri: string): string {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return UNPARSEABLE;
  }
  // `user:pw@x` parses as scheme `user:` with no host; never echo its path.
  if (!url.hostname) return UNPARSEABLE;
  const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  const name = url.pathname.replace(/^\//, '');
  return name ? `${host}/${name}` : host;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** True only when the connection string parses and names a loopback host. */
export function isLocalDbTarget(uri: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(uri).hostname);
  } catch {
    return false;
  }
}

/** The flag a dev-only writer needs before it will touch a non-local database. */
export const REMOTE_OVERRIDE_FLAG = '--i-mean-remote';

/**
 * Decide whether a dev-only script (seed, seed --reset) may write to `uri`:
 * `null` to proceed, otherwise the refusal to print. Pure, so it is tested
 * without connecting anywhere.
 */
export function remoteWriteRefusal(uri: string, argv: readonly string[]): string | null {
  if (isLocalDbTarget(uri) || argv.includes(REMOTE_OVERRIDE_FLAG)) return null;
  return (
    `refusing: ${describeDbTarget(uri)} is not a local database. ` +
    `This script writes fake data${argv.includes('--reset') ? ' and truncates every table but session' : ''}; ` +
    `pass ${REMOTE_OVERRIDE_FLAG} if you really mean it.`
  );
}
