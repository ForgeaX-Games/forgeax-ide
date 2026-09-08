import transport from '../release/transport-contract.v1.json';

export function validateTrustedReleaseUrl(value: string, kind: 'manifest' | 'binary', version?: string): string {
  if (/[^\x20-\x7e]/.test(value)) throw new Error('release URL contains non-ASCII or control characters');
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.port || url.origin !== transport.trustedSidecarSource.origin) throw new Error('release URL authority is not trusted');
  if (!url.pathname.startsWith(transport.trustedSidecarSource.repositoryPath)) throw new Error('release URL repository path is not trusted');
  const segments = url.pathname.slice(transport.trustedSidecarSource.repositoryPath.length).split('/');
  if (segments.length !== 2 || !/^server-v\d+\.\d+\.\d+$/.test(segments[0]) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segments[1])) throw new Error('release URL path is not canonical');
  if (segments.some((segment) => decodeURIComponent(segment) !== segment || segment === '.' || segment === '..')) throw new Error('release URL encoded path is forbidden');
  if (version && segments[0] !== `server-v${version}`) throw new Error('release URL version mismatch');
  if (kind === 'manifest' && !segments[1].endsWith('.json')) throw new Error('sidecar manifest URL must end in .json');
  if (kind === 'binary' && !/\.(?:zip|tar\.gz|bin|exe)$/.test(segments[1])) throw new Error('sidecar binary URL extension is forbidden');
  return url.toString();
}
