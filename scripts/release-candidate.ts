import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import contract from '../release/contract.json';
import transport from '../release/transport-contract.v1.json';
import { validateTrustedSidecarUrl, type ReleaseContext } from './resolve-release-context';

const sha40 = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const exactKeys = (value: object, keys: string[]): boolean => JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
type Mode = 'dry-run' | 'publish';
type FileRecord = { logicalId: string; fileName: string; mediaType: string; sha256: string; size: number };
type NativeTrust = 'unsigned-user-authorized' | 'suppressed-not-applicable';
type EvidenceCheck = { id: string; status: NativeTrust };
export type PlatformEvidence = {
  schema: 'forgeax-ide-platform-evidence/v1'; orchestrationId: string; mode: Mode; logicalId: string;
  targetTriple: string; trust: NativeTrust; signer: null;
  checks: EvidenceCheck[]; artifacts: FileRecord[];
};
export type PlatformRecord = {
  logicalId: string; targetTriple: string; trust: NativeTrust;
  artifacts: FileRecord[]; evidence: FileRecord[];
};
export type AggregateCandidate = {
  schema: 'forgeax-ide-release-candidate/v1'; digest: string; orchestrationId: string; mode: Mode;
  source: { ide: { repository: string; revision: string }; integration: { repository: string; revision: string } };
  target: { repository: string; tag: string; commit: string };
  publisher: { workflowPath: string; workflowRunId: string; workflowRunAttempt: string; workflowDefinitionRevision: string };
  sidecarManifest: { url: string; sha256: string };
  platforms: PlatformRecord[];
};
export type RecoveryRecord = {
  schema: 'forgeax-ide-release-recovery/v1'; orchestrationId: string; candidateDigest: string; mode: Mode;
  state: 'candidate-verified' | 'draft-reconciled' | 'completed'; mutation: 'suppressed' | 'draft' | 'published'; verified: boolean;
  releaseId: number | null; releaseUrl: string | null;
};

type LocalFile = FileRecord & { path: string };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function sha256Bytes(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
export function hashFile(path: string, logicalId: string, mediaType: string): LocalFile {
  const bytes = readFileSync(path);
  return { logicalId, fileName: basename(path), mediaType, sha256: sha256Bytes(bytes), size: bytes.byteLength, path };
}
export function computeCandidateDigest(candidate: Omit<AggregateCandidate, 'digest'>): string { return sha256Bytes(Buffer.from(canonical(candidate))); }

function walk(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
function directories(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? [path, ...directories(path)] : [];
  });
}

export function buildPlatformEvidence(input: { context: ReleaseContext; logicalId: string; bundleRoot: string; assetsOutput: string; evidenceOutput: string }): { record: PlatformRecord; evidence: PlatformEvidence } {
  const definition = transport.platforms.find((platform) => platform.logicalId === input.logicalId);
  if (!definition) throw new Error('unknown release platform');
  const candidates = walk(input.bundleRoot).filter((path) => /\.(?:dmg|msi|exe)$/i.test(path));
  const declared: LocalFile[] = definition.installerRoster.map((expected) => {
    const matches = candidates.filter((path) => path.toLowerCase().endsWith(expected.extension));
    if (matches.length !== 1) throw new Error(`exact installer roster mismatch for ${expected.logicalId}`);
    return hashFile(matches[0], expected.logicalId, expected.mediaType);
  });
  if (candidates.length !== declared.length) throw new Error('undeclared installer output is forbidden');
  const applications = input.logicalId.startsWith('macos') ? directories(input.bundleRoot).filter((path) => path.endsWith('.app')) : [];
  if (input.logicalId.startsWith('macos') && applications.length !== 1) throw new Error('exact macOS application roster mismatch');
  const publishChecks: EvidenceCheck[] = input.logicalId.startsWith('macos')
    ? [
      { id: 'macos-code-signing', status: 'unsigned-user-authorized' },
      { id: 'apple-notarization', status: 'unsigned-user-authorized' },
    ]
    : [{ id: 'windows-authenticode', status: 'unsigned-user-authorized' }];
  const verification = input.context.mode === 'publish'
    ? { signer: null, checks: publishChecks }
    : { signer: null, checks: [
      { id: 'native-signing', status: 'suppressed-not-applicable' as const },
      { id: 'external-mutation', status: 'suppressed-not-applicable' as const },
    ] };
  mkdirSync(input.assetsOutput, { recursive: true });
  const artifacts = declared.map((artifact) => {
    const fileName = `${artifact.logicalId}-${artifact.fileName}`;
    copyFileSync(artifact.path, join(input.assetsOutput, fileName));
    return { logicalId: artifact.logicalId, fileName, mediaType: artifact.mediaType, sha256: artifact.sha256, size: artifact.size };
  }).sort((a, b) => a.logicalId.localeCompare(b.logicalId));
  const evidence: PlatformEvidence = {
    schema: contract.platformEvidenceSchema as PlatformEvidence['schema'], orchestrationId: input.context.orchestrationId, mode: input.context.mode,
    logicalId: definition.logicalId, targetTriple: definition.targetTriple,
    trust: input.context.mode === 'publish' ? transport.nativeTrustPolicy as 'unsigned-user-authorized' : 'suppressed-not-applicable', signer: verification.signer,
    checks: verification.checks, artifacts,
  };
  mkdirSync(resolve(input.evidenceOutput, '..'), { recursive: true });
  writeFileSync(input.evidenceOutput, `${JSON.stringify(evidence, null, 2)}\n`);
  const evidenceFile = hashFile(input.evidenceOutput, `${definition.logicalId}-evidence`, 'application/json');
  return { evidence, record: { logicalId: definition.logicalId, targetTriple: definition.targetTriple, trust: evidence.trust, artifacts, evidence: [{ logicalId: evidenceFile.logicalId, fileName: basename(input.evidenceOutput), mediaType: evidenceFile.mediaType, sha256: evidenceFile.sha256, size: evidenceFile.size }] } };
}

function validateFileRecord(file: FileRecord): void {
  if (!exactKeys(file, ['logicalId', 'fileName', 'mediaType', 'sha256', 'size']) || !/^[a-z0-9][a-z0-9-]*$/.test(file.logicalId) || basename(file.fileName) !== file.fileName || !digestPattern.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('file record shape is invalid');
}

export function validatePlatformEvidence(evidence: PlatformEvidence, context: ReleaseContext): void {
  if (!exactKeys(evidence, ['schema','orchestrationId','mode','logicalId','targetTriple','trust','signer','checks','artifacts']) || evidence.schema !== contract.platformEvidenceSchema || evidence.orchestrationId !== context.orchestrationId || evidence.mode !== context.mode) throw new Error('platform evidence shape or binding is invalid');
  const definition = transport.platforms.find((platform) => platform.logicalId === evidence.logicalId);
  if (!definition || definition.targetTriple !== evidence.targetTriple || evidence.artifacts.length !== definition.installerRoster.length) throw new Error('platform evidence roster is invalid');
  evidence.artifacts.forEach(validateFileRecord);
  if (!Array.isArray(evidence.checks) || evidence.checks.length === 0 || evidence.checks.some((check) => !exactKeys(check, ['id','status']) || !check.id)) throw new Error('platform evidence checks are invalid');
  if (context.mode === 'dry-run') {
    if (evidence.trust !== 'suppressed-not-applicable' || evidence.signer !== null || evidence.checks.some((check) => check.status !== 'suppressed-not-applicable')) throw new Error('dry-run trust must be suppressed');
  } else if (transport.nativeTrustPolicy !== 'unsigned-user-authorized' || evidence.trust !== transport.nativeTrustPolicy || evidence.signer !== null || evidence.checks.some((check) => check.status !== transport.nativeTrustPolicy)) {
    throw new Error('publish platform evidence does not match the authorized unsigned policy');
  }
}

export function aggregateCandidate(context: ReleaseContext, records: PlatformRecord[]): AggregateCandidate {
  const sorted = [...records].sort((a, b) => a.logicalId.localeCompare(b.logicalId));
  if (JSON.stringify(sorted.map((item) => item.logicalId)) !== JSON.stringify(transport.platforms.map((item) => item.logicalId).sort())) throw new Error('platform roster mismatch');
  const material: Omit<AggregateCandidate, 'digest'> = {
    schema: contract.candidateSchema as AggregateCandidate['schema'], orchestrationId: context.orchestrationId, mode: context.mode,
    source: { ide: { repository: transport.sourceRepository, revision: context.ideRevision }, integration: { repository: transport.integrationRepository, revision: context.integrationRevision } },
    target: { repository: transport.releaseRepository, tag: context.targetTag, commit: context.integrationRevision },
    publisher: { workflowPath: transport.publisherWorkflowPath, workflowRunId: requiredEnv('GITHUB_RUN_ID'), workflowRunAttempt: requiredEnv('GITHUB_RUN_ATTEMPT'), workflowDefinitionRevision: context.workflowDefinitionRevision },
    sidecarManifest: { url: context.sidecarManifestUrl, sha256: context.sidecarManifestSha256 }, platforms: sorted,
  };
  return { ...material, digest: computeCandidateDigest(material) };
}

export function validateCandidate(candidate: AggregateCandidate, requiredMode?: Mode): void {
  if (!exactKeys(candidate, ['schema','digest','orchestrationId','mode','source','target','publisher','sidecarManifest','platforms']) || candidate.schema !== contract.candidateSchema || !digestPattern.test(candidate.digest) || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(candidate.orchestrationId) || candidate.orchestrationId.includes('--') || !['dry-run','publish'].includes(candidate.mode)) throw new Error('candidate shape is invalid');
  if (requiredMode && candidate.mode !== requiredMode) throw new Error(`candidate mode must be ${requiredMode}`);
  if (!exactKeys(candidate.source, ['ide','integration']) || !exactKeys(candidate.source.ide, ['repository','revision']) || !exactKeys(candidate.source.integration, ['repository','revision']) || candidate.source.ide.repository !== transport.sourceRepository || candidate.source.integration.repository !== transport.integrationRepository || !sha40.test(candidate.source.ide.revision) || !sha40.test(candidate.source.integration.revision)) throw new Error('candidate source binding is invalid');
  if (!exactKeys(candidate.target, ['repository','tag','commit']) || candidate.target.repository !== transport.releaseRepository || candidate.target.commit !== candidate.source.integration.revision || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(candidate.target.tag)) throw new Error('candidate target binding is invalid');
  if (!exactKeys(candidate.publisher, ['workflowPath','workflowRunId','workflowRunAttempt','workflowDefinitionRevision']) || candidate.publisher.workflowPath !== transport.publisherWorkflowPath || !/^[1-9]\d*$/.test(candidate.publisher.workflowRunId) || !/^[1-9]\d*$/.test(candidate.publisher.workflowRunAttempt) || !sha40.test(candidate.publisher.workflowDefinitionRevision)) throw new Error('candidate publisher binding is invalid');
  if (!exactKeys(candidate.sidecarManifest, ['url','sha256']) || !digestPattern.test(candidate.sidecarManifest.sha256)) throw new Error('candidate sidecar binding is invalid');
  validateTrustedSidecarUrl(candidate.sidecarManifest.url);
  if (JSON.stringify(candidate.platforms.map((platform) => platform.logicalId).sort()) !== JSON.stringify(transport.platforms.map((platform) => platform.logicalId).sort())) throw new Error('candidate platform roster is invalid');
  for (const platform of candidate.platforms) {
    if (!exactKeys(platform, ['logicalId','targetTriple','trust','artifacts','evidence'])) throw new Error('candidate platform shape is invalid');
    const definition = transport.platforms.find((entry) => entry.logicalId === platform.logicalId);
    if (!definition || definition.targetTriple !== platform.targetTriple || platform.artifacts.length !== definition.installerRoster.length || platform.evidence.length !== 1 || JSON.stringify(platform.artifacts.map((artifact) => artifact.logicalId).sort()) !== JSON.stringify(definition.installerRoster.map((artifact) => artifact.logicalId).sort())) throw new Error('candidate platform declaration is invalid');
    platform.artifacts.forEach(validateFileRecord); platform.evidence.forEach(validateFileRecord);
    if (candidate.mode === 'publish' && platform.trust !== transport.nativeTrustPolicy) throw new Error('publish candidate platform trust is invalid');
    if (candidate.mode === 'dry-run' && platform.trust !== 'suppressed-not-applicable') throw new Error('dry-run candidate platform trust is invalid');
  }
  const { digest, ...material } = candidate;
  if (computeCandidateDigest(material) !== digest) throw new Error('candidate digest mismatch');
}

export function validateRecoveryRecord(record: RecoveryRecord, candidate: AggregateCandidate): void {
  const allowed = ['schema','orchestrationId','candidateDigest','mode','state','mutation','verified','releaseId','releaseUrl'];
  if (!exactKeys(record, allowed) || record.schema !== contract.recoverySchema || record.orchestrationId !== candidate.orchestrationId || record.candidateDigest !== candidate.digest || record.mode !== candidate.mode || record.verified !== true) throw new Error('recovery record binding is invalid');
  if (record.state === 'candidate-verified' && (record.mutation !== 'suppressed' || record.releaseId !== null || record.releaseUrl !== null)) throw new Error('candidate recovery state is invalid');
  if (record.state === 'draft-reconciled' && (candidate.mode !== 'publish' || record.mutation !== 'draft' || !Number.isSafeInteger(record.releaseId) || !record.releaseUrl)) throw new Error('draft recovery state is invalid');
  if (record.state === 'completed' && (candidate.mode !== 'publish' || record.mutation !== 'published' || !Number.isSafeInteger(record.releaseId) || !record.releaseUrl)) throw new Error('completed recovery state is invalid');
  if (candidate.mode === 'dry-run' && record.mutation !== 'suppressed') throw new Error('dry-run recovery mutation must be suppressed');
}

export function readRecovery(path: string, candidate: AggregateCandidate): RecoveryRecord[] {
  const records = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as RecoveryRecord);
  if (records.length === 0) throw new Error('recovery journal is empty');
  records.forEach((record) => validateRecoveryRecord(record, candidate));
  return records;
}

export function verifyTransportFiles(candidate: AggregateCandidate, assetsRoot: string, evidenceRoot: string): void {
  const expectedAssets = candidate.platforms.flatMap((platform) => platform.artifacts);
  const expectedEvidence = candidate.platforms.flatMap((platform) => platform.evidence);
  const actualAssets = walk(assetsRoot);
  const actualEvidence = walk(evidenceRoot);
  if (actualAssets.length !== expectedAssets.length || actualEvidence.length !== expectedEvidence.length) throw new Error('transport contains undeclared files');
  for (const [records, root, actual] of [[expectedAssets, assetsRoot, actualAssets], [expectedEvidence, evidenceRoot, actualEvidence]] as const) {
    for (const record of records) {
      const matches = actual.filter((path) => basename(path) === record.fileName);
      if (matches.length !== 1) throw new Error(`transport file mismatch: ${record.fileName}`);
      const check = hashFile(matches[0], record.logicalId, record.mediaType);
      if (check.sha256 !== record.sha256 || check.size !== record.size) throw new Error(`transport digest mismatch: ${record.fileName}`);
    }
  }
}

function requiredEnv(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
function arg(name: string): string | undefined { const index = Bun.argv.indexOf(name); return index >= 0 ? Bun.argv[index + 1] : undefined; }
function readContext(): ReleaseContext { return JSON.parse(readFileSync(arg('--context')!, 'utf8')) as ReleaseContext; }

if (import.meta.main) {
  const command = Bun.argv[2];
  if (command === 'create-platform') {
    const context = readContext();
    const { record } = buildPlatformEvidence({ context, logicalId: arg('--logical-id')!, bundleRoot: arg('--bundle-root')!, assetsOutput: arg('--assets-output')!, evidenceOutput: arg('--evidence-output')! });
    const recordOutput = arg('--record-output')!;
    mkdirSync(resolve(recordOutput, '..'), { recursive: true });
    writeFileSync(recordOutput, `${JSON.stringify(record, null, 2)}\n`);
  } else if (command === 'aggregate') {
    const context = readContext();
    const recordsRoot = arg('--records-root');
    const recordPaths = recordsRoot ? walk(recordsRoot).filter((path) => path.endsWith('.json')) : JSON.parse(readFileSync(arg('--records-json')!, 'utf8')) as string[];
    const records = recordPaths.map((path) => JSON.parse(readFileSync(path, 'utf8')) as PlatformRecord);
    for (const record of records) {
      const evidencePath = join(arg('--evidence-root')!, record.evidence[0]?.fileName ?? '');
      const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as PlatformEvidence;
      validatePlatformEvidence(evidence, context);
      if (evidence.logicalId !== record.logicalId || evidence.targetTriple !== record.targetTriple || evidence.trust !== record.trust || canonical(evidence.artifacts) !== canonical(record.artifacts)) throw new Error('platform evidence does not match platform record');
    }
    const candidate = aggregateCandidate(context, records);
    validateCandidate(candidate);
    verifyTransportFiles(candidate, arg('--assets-root')!, arg('--evidence-root')!);
    const recovery: RecoveryRecord = { schema: contract.recoverySchema as RecoveryRecord['schema'], orchestrationId: candidate.orchestrationId, candidateDigest: candidate.digest, mode: candidate.mode, state: 'candidate-verified', mutation: 'suppressed', verified: true, releaseId: null, releaseUrl: null };
    writeFileSync(arg('--candidate-output')!, `${JSON.stringify(candidate, null, 2)}\n`);
    writeFileSync(arg('--recovery-output')!, `${JSON.stringify(recovery)}\n`);
  } else if (command === 'verify') {
    const candidate = JSON.parse(readFileSync(arg('--candidate')!, 'utf8')) as AggregateCandidate;
    validateCandidate(candidate, arg('--require-mode') as Mode | undefined);
    readRecovery(arg('--recovery')!, candidate);
    verifyTransportFiles(candidate, arg('--assets-root')!, arg('--evidence-root')!);
    console.log(JSON.stringify({ code: 'IDE_RELEASE_CANDIDATE_VALID', digest: candidate.digest, mode: candidate.mode }));
  } else throw new Error('usage: release-candidate <create-platform|aggregate|verify>');
}
