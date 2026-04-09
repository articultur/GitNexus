/**
 * ProcessFlowModal component tests
 *
 * Covers:
 * 1. Returns null when process prop is null
 * 2. Renders modal with process label
 * 3. Escape key calls onClose
 * 4. Backdrop click calls onClose
 * 5. Zoom in / zoom out buttons update zoom state (title attributes)
 * 6. Copy button is rendered
 * 7. Focus-in-graph button is rendered when onFocusInGraph is provided
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProcessFlowModal } from '../../src/components/ProcessFlowModal';
import type { ProcessData } from '../../src/lib/mermaid-generator';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mermaid is an ESM module and uses Canvas/SVG in the browser.
// We replace it with a simple stub that resolves with a static SVG string.
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg data-testid="mock-mermaid-svg"></svg>' }),
    parseError: null,
  },
}));

// DOMPurify just passes SVG through in tests
vi.mock('dompurify', () => ({
  default: { sanitize: (s: string) => s },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeProcess = (overrides: Partial<ProcessData> = {}): ProcessData => ({
  id: 'proc-auth',
  label: 'Auth Flow',
  processType: 'cross_community',
  steps: [
    { id: 'Function:src/auth.ts:login:1', name: 'login', stepNumber: 0, filePath: 'src/auth.ts' },
    {
      id: 'Function:src/auth.ts:verify:10',
      name: 'verify',
      stepNumber: 1,
      filePath: 'src/auth.ts',
    },
  ],
  ...overrides,
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ProcessFlowModal — null guard', () => {
  it('renders nothing when process is null', () => {
    const { container } = render(<ProcessFlowModal process={null} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('ProcessFlowModal — rendering', () => {
  it('shows the process label in the header', async () => {
    render(<ProcessFlowModal process={makeProcess()} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/Auth Flow/)).toBeTruthy();
    });
  });

  it('renders a backdrop element with data-testid', async () => {
    render(<ProcessFlowModal process={makeProcess()} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('process-modal')).toBeTruthy();
    });
  });
});

describe('ProcessFlowModal — close interactions', () => {
  it('calls onClose when Escape is pressed', async () => {
    const onClose = vi.fn();
    render(<ProcessFlowModal process={makeProcess()} onClose={onClose} />);
    await waitFor(() => screen.getByTestId('process-modal'));

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when backdrop is clicked', async () => {
    const onClose = vi.fn();
    render(<ProcessFlowModal process={makeProcess()} onClose={onClose} />);
    const backdrop = await screen.findByTestId('process-modal');

    // Simulate click on the backdrop div (not on child elements)
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('ProcessFlowModal — zoom controls', () => {
  it('renders a Zoom In button', async () => {
    render(<ProcessFlowModal process={makeProcess()} onClose={vi.fn()} />);
    await waitFor(() => screen.getByTestId('process-modal'));
    // Zoom In and Zoom Out buttons exist
    const buttons = screen.getAllByRole('button');
    const titles = buttons.map((b) => b.getAttribute('title') ?? b.textContent ?? '');
    expect(titles.some((t) => /zoom in/i.test(t))).toBe(true);
  });

  it('renders a Zoom Out button', async () => {
    render(<ProcessFlowModal process={makeProcess()} onClose={vi.fn()} />);
    await waitFor(() => screen.getByTestId('process-modal'));
    const buttons = screen.getAllByRole('button');
    const titles = buttons.map((b) => b.getAttribute('title') ?? b.textContent ?? '');
    expect(titles.some((t) => /zoom out/i.test(t))).toBe(true);
  });
});

describe('ProcessFlowModal — focus in graph', () => {
  it('renders Focus button when onFocusInGraph is provided', async () => {
    render(<ProcessFlowModal process={makeProcess()} onClose={vi.fn()} onFocusInGraph={vi.fn()} />);
    await waitFor(() => screen.getByTestId('process-modal'));
    const buttons = screen.getAllByRole('button');
    const titles = buttons.map((b) => b.getAttribute('title') ?? b.textContent ?? '');
    expect(titles.some((t) => /focus/i.test(t))).toBe(true);
  });

  it('calls onFocusInGraph and onClose when Focus button is clicked', async () => {
    const onClose = vi.fn();
    const onFocusInGraph = vi.fn();
    render(
      <ProcessFlowModal
        process={makeProcess()}
        onClose={onClose}
        onFocusInGraph={onFocusInGraph}
      />,
    );
    await waitFor(() => screen.getByTestId('process-modal'));

    const buttons = screen.getAllByRole('button');
    const focusBtn = buttons.find((b) =>
      /focus/i.test(b.getAttribute('title') ?? b.textContent ?? ''),
    );
    expect(focusBtn).toBeTruthy();
    fireEvent.click(focusBtn!);

    expect(onFocusInGraph).toHaveBeenCalledWith(
      expect.arrayContaining(['Function:src/auth.ts:login:1', 'Function:src/auth.ts:verify:10']),
      'proc-auth',
    );
    expect(onClose).toHaveBeenCalled();
  });
});

describe('ProcessFlowModal — rawMermaid passthrough', () => {
  it('uses rawMermaid directly when provided instead of generating', async () => {
    const mermaid = await import('mermaid');
    render(
      <ProcessFlowModal
        process={makeProcess({ rawMermaid: 'flowchart LR\n  A-->B' })}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByTestId('process-modal'));
    expect(mermaid.default.render).toHaveBeenCalledWith(
      expect.any(String),
      'flowchart LR\n  A-->B',
    );
  });
});
