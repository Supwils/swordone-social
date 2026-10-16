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

const DISPOSABLE_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', 'postgres']);
const DISPOSABLE_NAME = /_(test|e2e)(_pg)?$/;

/**
 * Throw unless `uri` names a database that is safe to migrate and TRUNCATE:
 * a loopback (or compose-service `postgres`) host AND a name ending in
 * `_test`, `_test_pg`, `_e2e` or `_e2e_pg`. The test runner and the e2e prep
 * script read DATABASE_URL straight from the shell, so an exported production
 * URL would otherwise be wiped by a plain `git commit`. Pure, tested without a DB.
 */
export function assertDisposableDb(uri: string): void {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error(`refusing to reset ${UNPARSEABLE}: not a disposable test database`);
  }
  const name = url.pathname.replace(/^\//, '');
  if (!url.hostname || !DISPOSABLE_HOSTS.has(url.hostname) || !DISPOSABLE_NAME.test(name)) {
    throw new Error(
      `refusing to migrate and truncate ${describeDbTarget(uri)}: a disposable test database ` +
        `must be on localhost/127.0.0.1/::1/postgres and be named *_test, *_test_pg, *_e2e or *_e2e_pg. ` +
        `Unset DATABASE_URL / E2E_DATABASE_URL in your shell to use the local default.`,
    );
  }
}
