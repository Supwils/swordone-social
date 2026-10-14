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
