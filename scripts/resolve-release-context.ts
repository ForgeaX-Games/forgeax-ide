import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import transport from '../release/transport-contract.v1.json';
import tagInputs from '../release/tag-release-inputs.json';
import product from '../product/forgeax-product.json';
import { validateTrustedReleaseUrl } from './release-source-contract';

const sha40 = /^[0-9a-f]{40}$/;
const sha256 = /^[0-9a-f]{64}$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const orchestrationPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function canonicalizeOrchestrationId(value: string): string {
  if (value !== value.trim() || !orchestrationPattern.test(value) || value.includes('--')) throw new Error('orchestration_id must be canonical lowercase ASCII with single hyphen separators');
  return value;
}

export function validateTrustedSidecarUrl(value: string): string {
  return validateTrustedReleaseUrl(value, 'manifest');
}

export type ReleaseContext = {
  orchestrationId: string;
  version: string;
  ideRevision: string;
  integrationRevision: string;
  revisionBranch: string;
  sidecarManifestUrl: string;
  sidecarManifestSha256: string;
  mode: 'dry-run' | 'publish';
  targetTag: string;
  serviceVersion: string;
  candidateArtifactName: string;
  assetsArtifactName: string;
  workflowDefinitionRevision: string;
};

export function resolveReleaseContext(env: Record<string, string | undefined>): ReleaseContext {
  const isTag = env.EVENT_NAME === 'push';
  const tag = tagInputs as {
    orchestrationId: string | null; integrationRevision: string; revisionBranch: string;
    sidecarCandidateManifestUrl: string | null; sidecarCandidateManifestSha256: string | null;
  };
  const gitHead = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (gitHead.status !== 0) throw new Error('unable to resolve IDE checkout revision');
  const actualIdeRevision = env.ACTUAL_IDE_REVISION ?? gitHead.stdout.trim();
  const version = isTag ? required(env, 'REF_NAME').replace(/^ide-v/, '') : required(env, 'REQUESTED_VERSION');
  const ideRevision = isTag ? actualIdeRevision : required(env, 'REQUESTED_IDE_REVISION');
  const integrationRevision = isTag ? tag.integrationRevision : required(env, 'REQUESTED_INTEGRATION_REVISION');
  const revisionBranch = isTag ? tag.revisionBranch : required(env, 'REQUESTED_REVISION_BRANCH');
  const sidecarManifestUrl = isTag ? tag.sidecarCandidateManifestUrl : required(env, 'REQUESTED_SIDECAR_URL');
  const sidecarManifestSha256 = isTag ? tag.sidecarCandidateManifestSha256 : required(env, 'REQUESTED_SIDECAR_SHA256');
  const mode = (isTag ? 'publish' : required(env, 'REQUESTED_INTENT')) as 'dry-run' | 'publish';
  const orchestrationId = canonicalizeOrchestrationId(isTag ? (tag.orchestrationId ?? '') : required(env, 'REQUESTED_ORCHESTRATION_ID'));
  const workflowDefinitionRevision = required(env, 'WORKFLOW_DEFINITION_REVISION');
  if (!versionPattern.test(version)) throw new Error('version is not exact semver');
  if (!/^(?:main|release\d{8})$/.test(revisionBranch)) throw new Error('revision branch is invalid');
  if (!sha40.test(ideRevision) || !sha40.test(integrationRevision) || !sha40.test(workflowDefinitionRevision)) throw new Error('release revisions must be exact SHA-1 values');
  if (ideRevision !== actualIdeRevision) throw new Error('IDE checkout does not match requested revision');
  if (!sidecarManifestUrl || !sidecarManifestSha256 || !sha256.test(sidecarManifestSha256)) throw new Error('tag/dispatch sidecar inputs are incomplete');
  if (mode !== 'dry-run' && mode !== 'publish') throw new Error('release intent is invalid');
  const server = product.services.find((service) => service.id === 'forgeax-server' && service.required);
  if (!server || !/^\d+\.\d+\.\d+$/.test(server.version)) throw new Error('required released server version is invalid');
  return {
    orchestrationId,
    version,
    ideRevision,
    integrationRevision,
    revisionBranch,
    sidecarManifestUrl: validateTrustedSidecarUrl(sidecarManifestUrl),
    sidecarManifestSha256,
    mode,
    targetTag: `${transport.tagPrefix}${version}`,
    serviceVersion: server.version,
    candidateArtifactName: transport.artifacts.candidate.replace('{orchestrationId}', orchestrationId),
    assetsArtifactName: transport.artifacts.assets.replace('{orchestrationId}', orchestrationId),
    workflowDefinitionRevision,
  };
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (import.meta.main) {
  const context = resolveReleaseContext(process.env);
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error('GITHUB_OUTPUT is required');
  for (const [key, value] of Object.entries(context)) {
    const outputKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    appendFileSync(output, `${outputKey}=${value}\n`);
  }
  const outputFile = process.env.RELEASE_CONTEXT_OUTPUT;
  if (outputFile) Bun.write(outputFile, `${JSON.stringify(context, null, 2)}\n`);
  console.log(JSON.stringify({ code: 'IDE_RELEASE_CONTEXT_VALID', orchestrationId: context.orchestrationId, mode: context.mode, targetTag: context.targetTag }));
}
