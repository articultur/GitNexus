import { beforeEach, describe, expect, it, vi } from 'vitest';

const initMock = vi.fn();
const callToolMock = vi.fn();
const writeSyncMock = vi.fn();

vi.mock('../../src/mcp/local/local-backend.js', () => ({
  LocalBackend: class {
    init = initMock;
    callTool = callToolMock;
  },
}));

vi.mock('node:fs', () => ({
  writeSync: writeSyncMock,
}));

describe('direct CLI tool commands', () => {
  beforeEach(() => {
    vi.resetModules();
    initMock.mockReset();
    callToolMock.mockReset();
    writeSyncMock.mockReset();
    initMock.mockResolvedValue(true);
  });

  it('dispatches detect_changes with CLI-shaped arguments', async () => {
    callToolMock.mockResolvedValue({
      summary: {
        changed_files: 1,
        changed_count: 2,
        affected_count: 1,
        risk_level: 'low',
      },
    });
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({
      scope: 'compare',
      baseRef: 'main',
      repo: 'gitnexus',
    });

    expect(callToolMock).toHaveBeenCalledWith('detect_changes', {
      scope: 'compare',
      base_ref: 'main',
      repo: 'gitnexus',
    });
    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('Risk level: low'));
  });

  it('prints "No changes detected." when changed_count is 0', async () => {
    callToolMock.mockResolvedValue({
      summary: { changed_files: 0, changed_count: 0, affected_count: 0, risk_level: 'low' },
    });
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({});

    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('No changes detected.'));
  });

  it('prints doc-only changes without claiming there were no file changes', async () => {
    callToolMock.mockResolvedValue({
      summary: {
        changed_files: 2,
        changed_count: 0,
        affected_count: 0,
        risk_level: 'low',
        risk_relevant_count: 0,
        documentation_files: 2,
        message: 'No indexed code symbols changed.',
      },
      changed_symbols: [],
    });
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({});

    const output: string = writeSyncMock.mock.calls[0][1];
    expect(output).toContain('Changes: 2 files, 0 symbols');
    expect(output).not.toContain('Risk-relevant symbols: 0');
    expect(output).toContain('Documentation-only files ignored for risk: 2');
    expect(output).toContain('No indexed code symbols changed.');
    expect(output).not.toContain('No changes detected.');
  });

  it('prints error message when result contains an error', async () => {
    callToolMock.mockResolvedValue({ error: 'index is stale' });
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({});

    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('Error: index is stale'));
  });

  it('truncates changed_symbols list beyond 15 and shows overflow count', async () => {
    const symbols = Array.from({ length: 17 }, (_, i) => ({
      type: 'function',
      name: `fn${i}`,
      filePath: `src/file${i}.ts`,
    }));
    callToolMock.mockResolvedValue({
      summary: { changed_files: 17, changed_count: 17, affected_count: 0, risk_level: 'low' },
      changed_symbols: symbols,
    });
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({});

    const output: string = writeSyncMock.mock.calls[0][1];
    expect(output).toContain('function fn14 → src/file14.ts');
    expect(output).not.toContain('fn15');
    expect(output).toContain('... and 2 more');
  });

  it('does not print undefined for missing changed symbol fields', async () => {
    callToolMock.mockResolvedValue({
      summary: {
        changed_files: 1,
        changed_count: 1,
        risk_relevant_count: 0,
        affected_count: 0,
        risk_level: 'low',
      },
      changed_symbols: [{ id: 'Function:src/a.ts:fallbackName', file: 'src/a.ts' }],
    });
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({});

    const output: string = writeSyncMock.mock.calls[0][1];
    expect(output).toContain('Risk-relevant symbols: 0');
    expect(output).toContain('Symbol Function:src/a.ts:fallbackName → src/a.ts');
    expect(output).not.toContain('undefined');
  });

  it('truncates affected_processes list beyond 10', async () => {
    const processes = Array.from({ length: 12 }, (_, i) => ({
      name: `proc${i}`,
      step_count: 3,
      changed_steps: [{ symbol: `sym${i}` }],
    }));
    callToolMock.mockResolvedValue({
      summary: { changed_files: 1, changed_count: 1, affected_count: 12, risk_level: 'low' },
      affected_processes: processes,
    });
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({});

    const output: string = writeSyncMock.mock.calls[0][1];
    expect(output).toContain('proc9');
    expect(output).not.toContain('proc10');
  });
});
