import { createServer, type Server } from "node:net";

export const DESKTOP_SERVER_BASE_PORT = 18_810;
export const DESKTOP_ENGINE_BASE_PORT = 15_273;
export const DESKTOP_GUARD_BASE_PORT = 25_273;
export const DESKTOP_MAX_PORT_OFFSET = 128;
export const DESKTOP_PORT_OFFSET_ENV = "FORGEAX_DESKTOP_PORT_OFFSET";

export type DesktopPorts = {
	readonly offset: number;
	readonly server: number;
	readonly engine: number;
	readonly guard: number;
};

export type DesktopPortLease = DesktopPorts & {
	/** Release the service socket reservations while retaining the handoff guard. */
	releaseReservations(): Promise<void>;
	release(): Promise<void>;
};

type ServerErrorEvents = {
	once(event: "error", listener: (error: Error) => void): void;
	removeListener(event: "error", listener: (error: Error) => void): void;
};

export function desktopPortsForOffset(offset: number): DesktopPorts {
	if (
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		offset > DESKTOP_MAX_PORT_OFFSET
	) {
		throw new Error(
			`${DESKTOP_PORT_OFFSET_ENV} must be an integer between 0 and ${DESKTOP_MAX_PORT_OFFSET}`,
		);
	}
	return {
		offset,
		server: DESKTOP_SERVER_BASE_PORT + offset,
		engine: DESKTOP_ENGINE_BASE_PORT + offset,
		guard: DESKTOP_GUARD_BASE_PORT + offset,
	};
}

function configuredOffset(raw: string | undefined): number | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	if (!/^\d+$/.test(raw.trim())) {
		throw new Error(
			`${DESKTOP_PORT_OFFSET_ENV} must be an integer between 0 and ${DESKTOP_MAX_PORT_OFFSET}`,
		);
	}
	return desktopPortsForOffset(Number(raw)).offset;
}

export function isDesktopPortBindConflict(error: unknown): boolean {
	return (
		error !== null &&
		typeof error === "object" &&
		(error as { code?: unknown }).code === "EADDRINUSE"
	);
}

function errorCode(error: unknown): string {
	return error !== null &&
		typeof error === "object" &&
		typeof (error as { code?: unknown }).code === "string"
		? (error as { code: string }).code
		: "unknown";
}

function reservationError(port: number, offset: number, error: unknown): Error {
	const detail = error instanceof Error ? error.message : String(error);
	const wrapped = new Error(
		`failed to reserve desktop port ${port} for offset ${offset} (${errorCode(error)}): ${detail}`,
		{ cause: error },
	);
	if (
		error !== null &&
		typeof error === "object" &&
		typeof (error as { code?: unknown }).code === "string"
	) {
		Object.defineProperty(wrapped, "code", {
			value: (error as { code: string }).code,
			enumerable: true,
		});
	}
	return wrapped;
}

function reservePort(port: number): Promise<Server> {
	return new Promise((resolve, reject) => {
		const reservation = createServer((socket) => socket.destroy());
		const events = reservation as Server & ServerErrorEvents;
		reservation.unref();
		events.once("error", reject);
		reservation.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
			events.removeListener("error", reject);
			resolve(reservation);
		});
	});
}

function closeReservation(reservation: Server | undefined): Promise<void> {
	if (!reservation) return Promise.resolve();
	return new Promise((resolve, reject) => {
		reservation.close((error) => (error ? reject(error) : resolve()));
	});
}

async function closeReservations(
	reservations: readonly (Server | undefined)[],
	offset: number,
): Promise<void> {
	const results = await Promise.allSettled(
		reservations.map((reservation) => closeReservation(reservation)),
	);
	const failures = results.flatMap((result) =>
		result.status === "rejected" ? [result.reason] : [],
	);
	if (failures.length > 0) {
		throw new AggregateError(
			failures,
			`failed to release desktop port reservations for offset ${offset}`,
		);
	}
}

async function cleanupAfterBindFailure(
	port: number,
	offset: number,
	error: unknown,
	guardReservation: Server | undefined,
	serverReservation: Server | undefined,
	engineReservation: Server | undefined,
): Promise<void> {
	try {
		await closeReservations(
			[guardReservation, serverReservation, engineReservation],
			offset,
		);
	} catch (cleanupError) {
		throw new AggregateError(
			[reservationError(port, offset, error), cleanupError],
			`failed to clean up after reserving desktop port ${port} for offset ${offset}`,
		);
	}
}

async function tryReservePorts(
	offset: number,
): Promise<DesktopPortLease | undefined> {
	const ports = desktopPortsForOffset(offset);
	let guardReservation: Server | undefined;
	let serverReservation: Server | undefined;
	let engineReservation: Server | undefined;
	try {
		guardReservation = await reservePort(ports.guard);
	} catch (error) {
		await cleanupAfterBindFailure(
			ports.guard,
			offset,
			error,
			guardReservation,
			serverReservation,
			engineReservation,
		);
		if (isDesktopPortBindConflict(error)) return undefined;
		throw reservationError(ports.guard, offset, error);
	}
	try {
		serverReservation = await reservePort(ports.server);
	} catch (error) {
		await cleanupAfterBindFailure(
			ports.server,
			offset,
			error,
			guardReservation,
			serverReservation,
			engineReservation,
		);
		if (isDesktopPortBindConflict(error)) return undefined;
		throw reservationError(ports.server, offset, error);
	}
	try {
		engineReservation = await reservePort(ports.engine);
	} catch (error) {
		await cleanupAfterBindFailure(
			ports.engine,
			offset,
			error,
			guardReservation,
			serverReservation,
			engineReservation,
		);
		if (isDesktopPortBindConflict(error)) return undefined;
		throw reservationError(ports.engine, offset, error);
	}
	let reservationRelease: Promise<void> | undefined;
	let leaseRelease: Promise<void> | undefined;
	const releaseReservations = async (): Promise<void> => {
		if (reservationRelease !== undefined) return reservationRelease;
		reservationRelease = (async () => {
			const currentServer = serverReservation;
			const currentEngine = engineReservation;
			serverReservation = undefined;
			engineReservation = undefined;
			await closeReservations([currentServer, currentEngine], offset);
		})();
		return reservationRelease;
	};
	return {
		...ports,
		releaseReservations,
		async release() {
			if (leaseRelease !== undefined) return leaseRelease;
			leaseRelease = (async () => {
				let releaseError: unknown;
				try {
					await releaseReservations();
				} catch (error) {
					releaseError = error;
				}
				const currentGuard = guardReservation;
				guardReservation = undefined;
				try {
					await closeReservations([currentGuard], offset);
				} catch (error) {
					if (releaseError === undefined) releaseError = error;
					else
						releaseError = new AggregateError(
							[releaseError, error],
							`failed to release desktop port lease for offset ${offset}`,
						);
				}
				if (releaseError !== undefined) throw releaseError;
			})();
			return leaseRelease;
		},
	};
}

export async function reserveDesktopPorts(
	rawOffset = process.env[DESKTOP_PORT_OFFSET_ENV],
): Promise<DesktopPortLease> {
	const requested = configuredOffset(rawOffset);
	const offsets =
		requested === undefined
			? Array.from(
					{ length: DESKTOP_MAX_PORT_OFFSET + 1 },
					(_, offset) => offset,
				)
			: [requested];
	for (const offset of offsets) {
		const lease = await tryReservePorts(offset);
		if (lease) return lease;
	}
	const scope =
		requested === undefined
			? `0..${DESKTOP_MAX_PORT_OFFSET}`
			: String(requested);
	throw new Error(
		`no desktop server/engine/guard port set is available for offset ${scope}`,
	);
}

export const DESKTOP_PORT_POLICY = {
	kind: "guarded-paired-offset",
	serverBase: DESKTOP_SERVER_BASE_PORT,
	engineBase: DESKTOP_ENGINE_BASE_PORT,
	guardBase: DESKTOP_GUARD_BASE_PORT,
	maximumOffset: DESKTOP_MAX_PORT_OFFSET,
	overrideEnvironment: DESKTOP_PORT_OFFSET_ENV,
} as const;
