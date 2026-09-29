import type { StudioDomainClients } from "./shell-state-domain-contract";
import type { SessionClient } from "./shell-state-session-contract";

// Product clients live for the page, independently of host mount and disposal.
let session: SessionClient | null = null;
let domains: StudioDomainClients | null = null;

export function configureSessionClient(client: SessionClient): void {
	session = client;
}

export function configureStudioDomainClients(
	clients: StudioDomainClients,
): void {
	domains = clients;
}

export const sessionClientRuntime = {
	read: (): SessionClient | null => session,
	write: configureSessionClient,
};

export const studioDomainClientRuntime = {
	read: (): StudioDomainClients | null => domains,
	write: configureStudioDomainClients,
};
