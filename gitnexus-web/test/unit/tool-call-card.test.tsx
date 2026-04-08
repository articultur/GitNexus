/**
 * ToolCallCard component tests
 *
 * Covers:
 * 1. Pure helper logic: formatArgs, getToolDisplayName, getStatusDisplay
 * 2. Rendered component behaviour: expand/collapse, content visibility
 */

import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolCallCard } from '../../src/components/ToolCallCard';
import type { ToolCallInfo } from '../../src/core/llm/types';

// ── Helpers ──────────────────────────────────────────────────────────────────
// The helpers are not exported from the module, so we test their observable
// effects via rendering / the exported component.

// ── Test fixtures ─────────────────────────────────────────────────────────────

const makeToolCall = (overrides: Partial<ToolCallInfo> = {}): ToolCallInfo => ({
  id: 'tc-1',
  name: 'search',
  args: { query: 'auth validation' },
  status: 'completed',
  ...overrides,
});

// ── Component rendering ───────────────────────────────────────────────────────

describe('ToolCallCard — display name mapping', () => {
  it('shows the friendly display name for known tools', () => {
    const knownTools: Array<[string, string]> = [
      ['search', '🔍 Search Code'],
      ['cypher', '🔗 Cypher Query'],
      ['grep', '🔎 Pattern Search'],
      ['read', '📄 Read File'],
      ['overview', '🗺️ Codebase Overview'],
      ['explore', '🔬 Deep Dive'],
      ['impact', '💥 Impact Analysis'],
    ];

    for (const [name, label] of knownTools) {
      const { unmount } = render(<ToolCallCard toolCall={makeToolCall({ name })} />);
      expect(screen.getByText(label)).toBeTruthy();
      unmount();
    }
  });

  it('falls back to the raw tool name for unknown tools', () => {
    render(<ToolCallCard toolCall={makeToolCall({ name: 'unknown_tool_xyz' })} />);
    expect(screen.getByText('unknown_tool_xyz')).toBeTruthy();
  });
});

describe('ToolCallCard — status display', () => {
  it('shows "running" status text', () => {
    render(<ToolCallCard toolCall={makeToolCall({ status: 'running' })} />);
    expect(screen.getByText('running')).toBeTruthy();
  });

  it('shows "completed" status text', () => {
    render(<ToolCallCard toolCall={makeToolCall({ status: 'completed' })} />);
    expect(screen.getByText('completed')).toBeTruthy();
  });

  it('shows "error" status text', () => {
    render(<ToolCallCard toolCall={makeToolCall({ status: 'error' })} />);
    expect(screen.getByText('error')).toBeTruthy();
  });
});

describe('ToolCallCard — expand / collapse', () => {
  it('is collapsed by default', () => {
    render(<ToolCallCard toolCall={makeToolCall({ result: 'some result' })} />);
    // Result section must not be visible when collapsed
    expect(screen.queryByText('some result')).toBeNull();
  });

  it('renders expanded when defaultExpanded=true', () => {
    render(<ToolCallCard toolCall={makeToolCall({ result: 'expanded result' })} defaultExpanded />);
    expect(screen.getByText('expanded result')).toBeTruthy();
  });

  it('expands when the header button is clicked', () => {
    render(<ToolCallCard toolCall={makeToolCall({ result: 'click result' })} />);
    // Click the header (role=button)
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('click result')).toBeTruthy();
  });

  it('collapses again on a second click', () => {
    render(<ToolCallCard toolCall={makeToolCall({ result: 'toggle result' })} />);
    const header = screen.getByRole('button');
    fireEvent.click(header);
    expect(screen.getByText('toggle result')).toBeTruthy();
    fireEvent.click(header);
    expect(screen.queryByText('toggle result')).toBeNull();
  });

  it('expands on Enter keydown', () => {
    render(<ToolCallCard toolCall={makeToolCall({ result: 'keyboard result' })} />);
    const header = screen.getByRole('button');
    fireEvent.keyDown(header, { key: 'Enter' });
    expect(screen.getByText('keyboard result')).toBeTruthy();
  });

  it('expands on Space keydown', () => {
    render(<ToolCallCard toolCall={makeToolCall({ result: 'space result' })} />);
    const header = screen.getByRole('button');
    fireEvent.keyDown(header, { key: ' ' });
    expect(screen.getByText('space result')).toBeTruthy();
  });
});

describe('ToolCallCard — formatArgs (via rendered output)', () => {
  it('renders nothing in the expanded section when args is empty', () => {
    render(
      <ToolCallCard toolCall={makeToolCall({ args: {}, result: undefined })} defaultExpanded />,
    );
    // No "Input" label should appear
    expect(screen.queryByText(/^Input$/i)).toBeNull();
  });

  it('renders the query string for a search/grep tool', () => {
    render(
      <ToolCallCard
        toolCall={makeToolCall({
          name: 'search',
          args: { query: 'validateSession' },
        })}
        defaultExpanded
      />,
    );
    expect(screen.getByText('validateSession')).toBeTruthy();
  });

  it('renders a Cypher query and its search prefix', () => {
    render(
      <ToolCallCard
        toolCall={makeToolCall({
          name: 'cypher',
          args: {
            query: 'auth flow',
            cypher: 'MATCH (n:Function) WHERE n.name CONTAINS "auth" RETURN n',
          },
        })}
        defaultExpanded
      />,
    );
    // Query label section should show the cypher block
    expect(screen.getByText(/MATCH/)).toBeTruthy();
    // The search: prefix is prepended
    expect(screen.getByText(/Search: "auth flow"/)).toBeTruthy();
  });

  it('renders JSON for non-query tool args', () => {
    render(
      <ToolCallCard
        toolCall={makeToolCall({
          name: 'read',
          args: { path: '/src/index.ts', line: 42 },
        })}
        defaultExpanded
      />,
    );
    // Should appear as JSON containing the keys
    expect(screen.getByText(/\"path\"/)).toBeTruthy();
    expect(screen.getByText(/\/src\/index\.ts/)).toBeTruthy();
  });
});

describe('ToolCallCard — result display', () => {
  it('does not render the result section when result is absent', () => {
    render(<ToolCallCard toolCall={makeToolCall({ result: undefined })} defaultExpanded />);
    expect(screen.queryByText('Result')).toBeNull();
  });

  it('renders the result section when result is present', () => {
    render(<ToolCallCard toolCall={makeToolCall({ result: 'found 3 matches' })} defaultExpanded />);
    expect(screen.getByText('found 3 matches')).toBeTruthy();
  });

  it('truncates results longer than 3000 characters', () => {
    const longResult = 'x'.repeat(3100);
    render(<ToolCallCard toolCall={makeToolCall({ result: longResult })} defaultExpanded />);
    expect(screen.getByText(/truncated/)).toBeTruthy();
  });

  it('shows loading indicator for running calls without a result', () => {
    render(
      <ToolCallCard
        toolCall={makeToolCall({ status: 'running', result: undefined })}
        defaultExpanded
      />,
    );
    expect(screen.getByText('Executing...')).toBeTruthy();
  });
});
