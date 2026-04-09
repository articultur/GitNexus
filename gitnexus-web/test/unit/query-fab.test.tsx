/**
 * QueryFAB component tests
 *
 * Covers:
 * 1. Toggle panel open / closed
 * 2. Keyboard shortcut (Escape) closes panel
 * 3. Error when no graph is loaded
 * 4. Error when database is not ready
 * 5. Example queries dropdown
 * 6. Run button is disabled when query is empty
 * 7. Successful query execution highlights nodes
 * 8. Clear button removes query and node highlights
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryFAB } from '../../src/components/QueryFAB';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockSetHighlightedNodeIds = vi.fn();
const mockSetQueryResult = vi.fn();
const mockClearQueryHighlights = vi.fn();
const mockRunQuery = vi.fn();
const mockIsDatabaseReady = vi.fn();

const makeAppState = (overrides = {}) => ({
  setHighlightedNodeIds: mockSetHighlightedNodeIds,
  setQueryResult: mockSetQueryResult,
  queryResult: null,
  clearQueryHighlights: mockClearQueryHighlights,
  graph: null,
  runQuery: mockRunQuery,
  isDatabaseReady: mockIsDatabaseReady,
  ...overrides,
});

vi.mock('../../src/hooks/useAppState', () => ({
  useAppState: vi.fn(),
}));

import { useAppState } from '../../src/hooks/useAppState';
const mockedUseAppState = vi.mocked(useAppState);

// ── Helpers ───────────────────────────────────────────────────────────────────

const minimalGraph = { nodes: [], relationships: [] } as any;

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockIsDatabaseReady.mockResolvedValue(true);
  mockRunQuery.mockResolvedValue([]);
  mockedUseAppState.mockReturnValue(makeAppState() as any);
});

describe('QueryFAB — toggle', () => {
  it('starts collapsed (no textarea visible)', () => {
    render(<QueryFAB />);
    expect(screen.queryByPlaceholderText(/MATCH/)).toBeNull();
  });

  it('click on FAB button expands the panel', () => {
    render(<QueryFAB />);
    // The FAB renders a button with Terminal icon; click it
    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]);
    expect(screen.getByPlaceholderText(/MATCH/)).toBeTruthy();
  });

  it('Escape key collapses the panel', () => {
    render(<QueryFAB />);
    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByPlaceholderText(/MATCH/)).toBeNull();
  });
});

describe('QueryFAB — run query errors', () => {
  it('shows "No project loaded" when graph is null', async () => {
    mockedUseAppState.mockReturnValue(makeAppState({ graph: null }) as any);
    render(<QueryFAB />);

    // Open panel
    fireEvent.click(screen.getAllByRole('button')[0]);

    // Type a query
    const textarea = screen.getByPlaceholderText(/MATCH/);
    fireEvent.change(textarea, { target: { value: 'MATCH (n) RETURN n' } });

    // Click Run
    const runBtn = screen.getByRole('button', { name: /run/i });
    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(screen.getByText(/No project loaded/)).toBeTruthy();
    });
  });

  it('shows "Database not ready" when isDatabaseReady returns false', async () => {
    mockIsDatabaseReady.mockResolvedValue(false);
    mockedUseAppState.mockReturnValue(makeAppState({ graph: minimalGraph }) as any);
    render(<QueryFAB />);

    fireEvent.click(screen.getAllByRole('button')[0]);
    fireEvent.change(screen.getByPlaceholderText(/MATCH/), {
      target: { value: 'MATCH (n) RETURN n' },
    });
    fireEvent.click(screen.getByRole('button', { name: /run/i }));

    await waitFor(() => {
      expect(screen.getByText(/Database not ready/)).toBeTruthy();
    });
  });
});

describe('QueryFAB — run button state', () => {
  beforeEach(() => {
    mockedUseAppState.mockReturnValue(makeAppState({ graph: minimalGraph }) as any);
    render(<QueryFAB />);
    fireEvent.click(screen.getAllByRole('button')[0]);
  });

  it('run button is disabled when query is empty', () => {
    const runBtn = screen.getByRole('button', { name: /run/i });
    expect(runBtn).toHaveAttribute('disabled');
  });

  it('run button is enabled when query has text', () => {
    fireEvent.change(screen.getByPlaceholderText(/MATCH/), {
      target: { value: 'MATCH (n) RETURN n' },
    });
    const runBtn = screen.getByRole('button', { name: /run/i });
    expect(runBtn).not.toHaveAttribute('disabled');
  });
});

describe('QueryFAB — examples dropdown', () => {
  beforeEach(() => {
    mockedUseAppState.mockReturnValue(makeAppState({ graph: minimalGraph }) as any);
    render(<QueryFAB />);
    fireEvent.click(screen.getAllByRole('button')[0]);
  });

  it('shows example list when Examples button is clicked', () => {
    const examplesBtn = screen.getByRole('button', { name: /examples/i });
    fireEvent.click(examplesBtn);
    expect(screen.getByText('All Functions')).toBeTruthy();
    expect(screen.getByText('All Classes')).toBeTruthy();
  });

  it('selecting an example sets the textarea value', () => {
    const examplesBtn = screen.getByRole('button', { name: /examples/i });
    fireEvent.click(examplesBtn);
    fireEvent.click(screen.getByText('All Functions'));

    const textarea = screen.getByPlaceholderText(/MATCH/) as HTMLTextAreaElement;
    expect(textarea.value).toMatch(/MATCH.*Function/);
  });
});

describe('QueryFAB — clear', () => {
  beforeEach(() => {
    mockedUseAppState.mockReturnValue(makeAppState({ graph: minimalGraph }) as any);
    render(<QueryFAB />);
    fireEvent.click(screen.getAllByRole('button')[0]);
  });

  it('Clear button clears query text and highlights', () => {
    fireEvent.change(screen.getByPlaceholderText(/MATCH/), {
      target: { value: 'MATCH (n) RETURN n' },
    });

    const clearBtn = screen.getByRole('button', { name: /^clear$/i });
    fireEvent.click(clearBtn);

    const textarea = screen.getByPlaceholderText(/MATCH/) as HTMLTextAreaElement;
    expect(textarea.value).toBe('');
    expect(mockClearQueryHighlights).toHaveBeenCalled();
  });
});

describe('QueryFAB — successful query', () => {
  it('calls setQueryResult with rows and executionTime on success', async () => {
    const rows = [{ id: 'Function:src/app.ts:main:1', name: 'main' }];
    mockRunQuery.mockResolvedValue(rows);
    mockedUseAppState.mockReturnValue(makeAppState({ graph: minimalGraph }) as any);

    render(<QueryFAB />);
    fireEvent.click(screen.getAllByRole('button')[0]);
    fireEvent.change(screen.getByPlaceholderText(/MATCH/), {
      target: { value: 'MATCH (n:Function) RETURN n' },
    });
    fireEvent.click(screen.getByRole('button', { name: /run/i }));

    await waitFor(() => {
      expect(mockSetQueryResult).toHaveBeenCalledWith(
        expect.objectContaining({ rows, executionTime: expect.any(Number) }),
      );
    });
  });
});
