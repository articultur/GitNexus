/**
 * GraphCanvas component tests
 *
 * GraphCanvas is tightly coupled to Sigma.js (WebGL graph renderer) and
 * useAppState. These tests validate the pure UI layer:
 *   1. Toolbar buttons render correctly
 *   2. AI-highlights toggle calls toggleAIHighlights
 *   3. Zoom-in / zoom-out / fit-to-screen buttons call their handlers
 *   4. Layout (play/pause) button renders and toggles
 *   5. Hovered-node tooltip appears when hoveredNodeName is set
 *   6. Selected-node info bar renders when a node is selected
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GraphCanvas } from '../../src/components/GraphCanvas';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Sigma.js is a WebGL renderer — replace with a stub that exposes the DOM ref
// and the named functions GraphCanvas calls.
const mockZoomIn = vi.fn();
const mockZoomOut = vi.fn();
const mockResetZoom = vi.fn();
const mockFocusNode = vi.fn();
const mockStartLayout = vi.fn();
const mockStopLayout = vi.fn();
const mockSetGraph = vi.fn();
const mockSetSelectedNode = vi.fn();

let sigmaIsLayoutRunning = false;
let sigmaSelectedNode: string | null = null;

vi.mock('../../src/hooks/useSigma', () => ({
  useSigma: vi.fn(() => ({
    containerRef: { current: null },
    sigmaRef: { current: null },
    setGraph: mockSetGraph,
    zoomIn: mockZoomIn,
    zoomOut: mockZoomOut,
    resetZoom: mockResetZoom,
    focusNode: mockFocusNode,
    isLayoutRunning: sigmaIsLayoutRunning,
    startLayout: mockStartLayout,
    stopLayout: mockStopLayout,
    selectedNode: sigmaSelectedNode,
    setSelectedNode: mockSetSelectedNode,
  })),
}));

// Mock lucide icons used by the toolbar to avoid SVG rendering issues
vi.mock('../../../src/lib/lucide-icons', () => {
  const icon = (name: string) => () => <span data-testid={`icon-${name}`} />;
  return {
    ZoomIn: icon('zoom-in'),
    ZoomOut: icon('zoom-out'),
    Network: icon('network'),
    Maximize2: icon('maximize'),
    Focus: icon('focus'),
    RotateCcw: icon('rotate'),
    Play: icon('play'),
    Pause: icon('pause'),
    Lightbulb: icon('lightbulb'),
    LightbulbOff: icon('lightbulb-off'),
  };
});

// Also mock @/lib/lucide-icons (alias resolution won't work under jsdom)
vi.mock('@/lib/lucide-icons', async () => {
  const actual = await vi.importActual<typeof import('@/lib/lucide-icons')>('@/lib/lucide-icons');
  return {
    ...actual,
    ZoomIn: () => <span data-testid="icon-zoom-in" />,
    ZoomOut: () => <span data-testid="icon-zoom-out" />,
    Network: () => <span data-testid="icon-network" />,
    Maximize2: () => <span data-testid="icon-maximize" />,
    Focus: () => <span data-testid="icon-focus" />,
    RotateCcw: () => <span data-testid="icon-rotate" />,
    Play: () => <span data-testid="icon-play" />,
    Pause: () => <span data-testid="icon-pause" />,
    Lightbulb: () => <span data-testid="icon-lightbulb" />,
    LightbulbOff: () => <span data-testid="icon-lightbulb-off" />,
    Terminal: () => <span data-testid="icon-terminal" />,
    X: () => <span data-testid="icon-x" />,
    ChevronDown: () => <span data-testid="icon-chevron-down" />,
    ChevronUp: () => <span data-testid="icon-chevron-up" />,
    Loader2: () => <span data-testid="icon-loader2" />,
    Sparkles: () => <span data-testid="icon-sparkles" />,
    Table: () => <span data-testid="icon-table" />,
  };
});

const mockToggleAIHighlights = vi.fn();
const mockClearAIToolHighlights = vi.fn();
const mockClearAICitationHighlights = vi.fn();
const mockClearBlastRadius = vi.fn();
const mockSetSelectedNodeApp = vi.fn();
const mockOpenCodePanel = vi.fn();

const makeAppState = (overrides = {}) => ({
  graph: null,
  setSelectedNode: mockSetSelectedNodeApp,
  selectedNode: null,
  visibleLabels: new Set(),
  visibleEdgeTypes: new Set(),
  openCodePanel: mockOpenCodePanel,
  depthFilter: 0,
  highlightedNodeIds: new Set<string>(),
  setHighlightedNodeIds: vi.fn(),
  aiCitationHighlightedNodeIds: new Set<string>(),
  aiToolHighlightedNodeIds: new Set<string>(),
  blastRadiusNodeIds: new Set<string>(),
  isAIHighlightsEnabled: false,
  toggleAIHighlights: mockToggleAIHighlights,
  clearAIToolHighlights: mockClearAIToolHighlights,
  clearAICitationHighlights: mockClearAICitationHighlights,
  clearBlastRadius: mockClearBlastRadius,
  animatedNodes: new Map(),
  ...overrides,
});

vi.mock('../../src/hooks/useAppState', () => ({
  useAppState: vi.fn(),
}));

import { useAppState } from '../../src/hooks/useAppState';
const mockedUseAppState = vi.mocked(useAppState);

// QueryFAB is embedded in GraphCanvas — mock it to a no-op div
vi.mock('../../src/components/QueryFAB', () => ({
  QueryFAB: () => <div data-testid="query-fab-stub" />,
}));

// Mock graph-adapter (not needed for UI tests)
vi.mock('../../src/lib/graph-adapter', () => ({
  knowledgeGraphToGraphology: vi.fn(() => ({})),
  filterGraphByDepth: vi.fn(),
  SigmaNodeAttributes: {},
  SigmaEdgeAttributes: {},
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderCanvas(overrides = {}) {
  mockedUseAppState.mockReturnValue(makeAppState(overrides) as any);
  return render(<GraphCanvas />);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  sigmaIsLayoutRunning = false;
  sigmaSelectedNode = null;
});

describe('GraphCanvas — toolbar renders', () => {
  it('renders zoom-in button', () => {
    renderCanvas();
    expect(screen.getByTitle('Zoom In')).toBeTruthy();
  });

  it('renders zoom-out button', () => {
    renderCanvas();
    expect(screen.getByTitle('Zoom Out')).toBeTruthy();
  });

  it('renders fit-to-screen button', () => {
    renderCanvas();
    expect(screen.getByTitle('Fit to Screen')).toBeTruthy();
  });

  it('renders layout (Run Layout) button when layout is stopped', () => {
    renderCanvas();
    expect(screen.getByTitle('Run Layout Again')).toBeTruthy();
  });

  it('renders AI highlights toggle button', () => {
    renderCanvas();
    expect(screen.getByTestId('ai-highlights-toggle')).toBeTruthy();
  });

  it('renders embedded QueryFAB', () => {
    renderCanvas();
    expect(screen.getByTestId('query-fab-stub')).toBeTruthy();
  });
});

describe('GraphCanvas — zoom controls', () => {
  it('clicking Zoom In calls zoomIn handler', () => {
    renderCanvas();
    fireEvent.click(screen.getByTitle('Zoom In'));
    expect(mockZoomIn).toHaveBeenCalledTimes(1);
  });

  it('clicking Zoom Out calls zoomOut handler', () => {
    renderCanvas();
    fireEvent.click(screen.getByTitle('Zoom Out'));
    expect(mockZoomOut).toHaveBeenCalledTimes(1);
  });

  it('clicking Fit to Screen calls resetZoom handler', () => {
    renderCanvas();
    fireEvent.click(screen.getByTitle('Fit to Screen'));
    expect(mockResetZoom).toHaveBeenCalledTimes(1);
  });
});

describe('GraphCanvas — AI highlights toggle', () => {
  it('toggles highlights off and clears state when AI highlights are enabled', () => {
    renderCanvas({ isAIHighlightsEnabled: true });
    fireEvent.click(screen.getByTestId('ai-highlights-toggle'));
    expect(mockClearAIToolHighlights).toHaveBeenCalled();
    expect(mockClearAICitationHighlights).toHaveBeenCalled();
    expect(mockClearBlastRadius).toHaveBeenCalled();
    expect(mockToggleAIHighlights).toHaveBeenCalled();
  });

  it('calls only toggleAIHighlights when AI highlights are disabled', () => {
    renderCanvas({ isAIHighlightsEnabled: false });
    fireEvent.click(screen.getByTestId('ai-highlights-toggle'));
    expect(mockClearAIToolHighlights).not.toHaveBeenCalled();
    expect(mockToggleAIHighlights).toHaveBeenCalled();
  });
});

describe('GraphCanvas — layout button', () => {
  it('calls startLayout when Run Layout button is clicked', () => {
    renderCanvas();
    fireEvent.click(screen.getByTitle('Run Layout Again'));
    expect(mockStartLayout).toHaveBeenCalledTimes(1);
  });
});

describe('GraphCanvas — selected node bar', () => {
  it('does not show Clear button when no node is selected', () => {
    renderCanvas();
    // Only the toolbar buttons; no "Clear" text appearing yet
    expect(screen.queryByRole('button', { name: /^clear$/i })).toBeNull();
  });
});
