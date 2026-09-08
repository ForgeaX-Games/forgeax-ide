import { describe, expect, it } from 'bun:test';

type Component = { id: string; required: boolean; status: 'ready' | 'failed' };
type Report = { status: 'product-ready' | 'degraded' | 'failed'; components: Component[]; diagnostics: { code: string; phase: string; component: string; recoveryActions: string[] }[] };

function aggregate(components: Component[]): Report {
  const failed = components.filter((component) => component.status === 'failed');
  const requiredFailure = failed.find((component) => component.required);
  return {
    status: requiredFailure ? 'failed' : failed.length ? 'degraded' : 'product-ready',
    components,
    diagnostics: failed.map((component) => ({ code: component.required ? 'IDE_REQUIRED_COMPONENT_FAILED' : 'IDE_OPTIONAL_COMPONENT_FAILED', phase: 'activate', component: component.id, recoveryActions: ['restore-locked-artifact', 'retry-activation'] })),
  };
}

describe('ProductRuntimeReportV1 contract', () => {
  it('marks all-ready products as product-ready', () => expect(aggregate([{ id: 'agent', required: true, status: 'ready' }]).status).toBe('product-ready'));
  it('does not hide required failures', () => {
    const report = aggregate([{ id: 'agent', required: true, status: 'failed' }]);
    expect(report.status).toBe('failed');
    expect(report.diagnostics[0]).toMatchObject({ code: 'IDE_REQUIRED_COMPONENT_FAILED', phase: 'activate', component: 'agent' });
  });
  it('degrades for optional failures while retaining recovery actions', () => {
    const report = aggregate([{ id: 'agent', required: true, status: 'ready' }, { id: 'preview', required: false, status: 'failed' }]);
    expect(report.status).toBe('degraded');
    expect(report.diagnostics[0].recoveryActions.length).toBeGreaterThan(0);
  });
});
