// Bun records a mirror's tarball URL even for ordinary registry resolutions.
// That URL wins over BUN_CONFIG_REGISTRY on later frozen installs. Its empty
// URL representation preserves the locked version and integrity while letting
// the installing environment choose the registry. Direct URL dependencies,
// Git dependencies and workspace links retain their original identity.
export function registryIndependentLock(lock: string): string {
	return lock.replace(
		/^(\s*"[^"]+": \["(?:@[^/"@]+\/)?[^@"]+@\d[^"]*", )"https?:\/\/[^"\r\n]+\.tgz"/gm,
		'$1""',
	);
}
