import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeParameterized: vi.fn(),
  parseDiffWithDegradation: vi.fn(),
  isGitRepo: vi.fn(),
}));

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: (...args: any[]) => mocks.executeParameterized(...args),
}));

vi.mock('../../src/mcp/local/tools/git-diff-parser.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/mcp/local/tools/git-diff-parser.js')
  >();
  return {
    ...actual,
    parseDiffWithDegradation: (...args: any[]) => mocks.parseDiffWithDegradation(...args),
  };
});

vi.mock('../../src/storage/git.js', () => ({
  isGitRepo: (...args: any[]) => mocks.isGitRepo(...args),
}));

import { detectChangesTool } from '../../src/mcp/local/tools/detect.js';

const repo = { id: 'repo-id', repoPath: '/repo' } as any;
const ensureInitialized = vi.fn().mockResolvedValue(undefined);

const hunk = (newStart: number, newEnd: number, content: string) => ({
  oldStart: newStart,
  oldEnd: newEnd,
  newStart,
  newEnd,
  lines: [{ type: 'added' as const, content, lineNumber: newStart }],
});

describe('detectChangesTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isGitRepo.mockReturnValue(true);
    mocks.parseDiffWithDegradation.mockResolvedValue({
      success: true,
      precision: 'normal',
      diffSize: 512,
      files: [],
    });
    mocks.executeParameterized.mockResolvedValue([]);
  });

  it('filters markdown headings out of changed symbols and risk scoring', async () => {
    mocks.parseDiffWithDegradation.mockResolvedValue({
      success: true,
      precision: 'normal',
      diffSize: 1024,
      files: [
        {
          path: 'AGENTS.md',
          status: 'modified',
          hunks: [hunk(1, 2, '# Guide')],
        },
      ],
    });
    mocks.executeParameterized.mockImplementation(async (_repoId, query: string, params: any) => {
      if (query.includes('WHERE n.filePath CONTAINS')) {
        expect(params.filePath).toBe('AGENTS.md');
        return [
          {
            id: 'Section:AGENTS.md:L1:Guide',
            name: 'Guide',
            type: undefined,
            filePath: 'AGENTS.md',
            startLine: 1,
            endLine: 4,
            content: '# Guide',
          },
        ];
      }
      return [];
    });

    const result = await detectChangesTool(repo, {}, ensureInitialized);

    expect(result.summary).toMatchObject({
      changed_files: 1,
      changed_count: 0,
      risk_relevant_count: 0,
      affected_count: 0,
      risk_level: 'low',
      documentation_files: 1,
      message: 'No indexed code symbols changed.',
    });
    expect(result.changed_symbols).toEqual([]);
    expect(result.affected_processes).toEqual([]);
  });

  it('infers missing symbol type from id and only scores code symbols', async () => {
    mocks.parseDiffWithDegradation.mockResolvedValue({
      success: true,
      precision: 'normal',
      diffSize: 2048,
      files: [
        {
          path: 'AGENTS.md',
          status: 'modified',
          hunks: [hunk(1, 2, '# Guide')],
        },
        {
          path: 'Core/B2HAppEngine.cpp',
          status: 'modified',
          hunks: [hunk(42, 44, 'B2HAppEngine();')],
        },
      ],
    });
    mocks.executeParameterized.mockImplementation(async (_repoId, query: string, params: any) => {
      if (query.includes('WHERE n.filePath CONTAINS')) {
        if (params.filePath === 'AGENTS.md') {
          return [
            {
              id: 'Section:AGENTS.md:L1:Guide',
              name: 'Guide',
              type: undefined,
              filePath: 'AGENTS.md',
              startLine: 1,
              endLine: 4,
              content: '# Guide',
            },
          ];
        }
        if (params.filePath === 'Core/B2HAppEngine.cpp') {
          return [
            {
              id: 'Function:Core/B2HAppEngine.cpp:B2HAppEngine',
              name: 'B2HAppEngine',
              type: undefined,
              filePath: 'Core/B2HAppEngine.cpp',
              startLine: 40,
              endLine: 80,
              content: 'void B2HAppEngine() {}',
            },
          ];
        }
      }
      return [];
    });

    const result = await detectChangesTool(repo, {}, ensureInitialized);

    expect(result.summary).toMatchObject({
      changed_files: 2,
      changed_count: 1,
      risk_relevant_count: 1,
      documentation_files: 1,
    });
    expect(result.changed_symbols).toHaveLength(1);
    expect(result.changed_symbols[0]).toMatchObject({
      type: 'Function',
      name: 'B2HAppEngine',
      filePath: 'Core/B2HAppEngine.cpp',
    });
    expect(
      mocks.executeParameterized.mock.calls.some(
        ([, query, params]) => query.includes('STEP_IN_PROCESS') && params.nodeId?.includes('Section'),
      ),
    ).toBe(false);
  });
});