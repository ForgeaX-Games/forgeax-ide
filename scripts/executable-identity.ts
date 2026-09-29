import { type DesktopPlatform, platformTargets } from "./desktop-platforms";

type ExecutableFormat = "mach-o" | "elf" | "pe";
type Architecture = "arm64" | "x64";
type ExecutableIdentity = {
	format: ExecutableFormat;
	architectures: Architecture[];
};

function architecture(cpu: number): Architecture | undefined {
	if (cpu === 0x0100000c || cpu === 183 || cpu === 0xaa64) return "arm64";
	if (cpu === 0x01000007 || cpu === 62 || cpu === 0x8664) return "x64";
	return undefined;
}

export function executableIdentity(bytes: Uint8Array): ExecutableIdentity {
	const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (data.length < 64) throw new Error("executable header is truncated");
	const magic = data.readUInt32BE(0);
	if (magic === 0xcafebabe || magic === 0xcafebabf) {
		const count = data.readUInt32BE(4);
		const stride = magic === 0xcafebabe ? 20 : 32;
		if (count < 1 || count > 16 || data.length < 8 + count * stride)
			throw new Error("invalid universal Mach-O header");
		const architectures = new Set<Architecture>();
		for (let index = 0; index < count; index++) {
			const arch = architecture(data.readUInt32BE(8 + index * stride));
			if (!arch) throw new Error("unsupported universal Mach-O architecture");
			architectures.add(arch);
		}
		return { format: "mach-o", architectures: [...architectures] };
	}
	if (magic === 0xcffaedfe || magic === 0xfeedfacf) {
		const cpu =
			magic === 0xcffaedfe ? data.readUInt32LE(4) : data.readUInt32BE(4);
		const arch = architecture(cpu);
		if (!arch) throw new Error("unsupported Mach-O architecture");
		return { format: "mach-o", architectures: [arch] };
	}
	if (data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
		if (data[4] !== 2 || data[5] !== 1)
			throw new Error("unsupported ELF class or byte order");
		const arch = architecture(data.readUInt16LE(18));
		if (!arch) throw new Error("unsupported ELF architecture");
		return { format: "elf", architectures: [arch] };
	}
	if (data.readUInt16LE(0) === 0x5a4d) {
		const offset = data.readUInt32LE(0x3c);
		if (
			offset > data.length - 6 ||
			data.toString("ascii", offset, offset + 4) !== "PE\0\0"
		)
			throw new Error("invalid PE header");
		const arch = architecture(data.readUInt16LE(offset + 4));
		if (!arch) throw new Error("unsupported PE architecture");
		return { format: "pe", architectures: [arch] };
	}
	throw new Error("unknown executable format");
}

export function assertTargetExecutable(
	bytes: Uint8Array,
	platform: DesktopPlatform,
): ExecutableIdentity {
	const target = platformTargets[platform];
	const expectedFormat =
		target.os === "darwin" ? "mach-o" : target.os === "linux" ? "elf" : "pe";
	const identity = executableIdentity(bytes);
	if (
		identity.format !== expectedFormat ||
		identity.architectures.length !== 1 ||
		identity.architectures[0] !== target.arch
	)
		throw new Error(
			`executable platform/architecture mismatch for ${platform}: ${identity.format}/${identity.architectures.join(",")}`,
		);
	return identity;
}
