/**
 * Unit Tests: Core Embeddings Embedder — Local Pipeline Path
 *
 * Covers the code paths in src/core/embeddings/embedder.ts that are NOT hit by
 * http-embedder.test.ts (which focuses on HTTP mode delegation).
 *
 * What is tested here:
 *   - initEmbedder() in local (non-HTTP) mode with a mocked transformers pipeline
 *   - Device fallback: dml → cuda → cpu → wasm
 *   - getEmbedder() throws before init
 *   - disposeEmbedder() resets module state
 *   - embedText() / embedBatch() in local mode (mocked pipeline)
 *   - embedBatch() empty-input guard
 *   - embeddingToArray() Float32Array → number[]
 *   - getEmbeddingDimensions() in local mode
 *   - getCurrentDevice()
 *
 * What is NOT tested here:
 *   - Actual transformer inference / real CUDA (requires hardware)
 *   - Internal hasOrtCudaProvider / isCudaAvailable (private, tested indirectly)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted() captures references at parse time — stable across the test file.
// This avoids the "embedder is not a function" error that occurs when
// vi.mock factories re-evaluate after vi.resetModules() with mockReset().
const { mockExistsSync, mockExecFileSync, mockPipeline } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockExecFileSync: vi.fn(),
  // pipeline() is a vi.fn that must be callable and return a Promise
  mockPipeline: vi.fn(),
}));

vi.mock('fs', () => ({ existsSync: mockExistsSync }));
vi.mock('child_process', () => ({ execFileSync: mockExecFileSync }));

// pipeline() from @huggingface/transformers is a callable function that resolves
// to { data: Float32Array }. We wrap mockPipeline in vi.fn so it is callable.
vi.mock('@huggingface/transformers', () => ({
  pipeline: mockPipeline,
  env: { allowLocalModels: false },
}));

const ENV_KEYS = [
  'GITNEXUS_EMBEDDING_URL',
  'GITNEXUS_EMBEDDING_MODEL',
  'GITNEXUS_EMBEDDING_API_KEY',
  'GITNEXUS_EMBEDDING_DIMS',
  'CUDA_PATH',
  'LD_LIBRARY_PATH',
  'ORT_LOG_LEVEL',
] as const;

const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const clearEnv = () => {
  for (const k of ENV_KEYS) delete process.env[k];
};

// Default mock setup: CPU environment (no CUDA)
const setupCpuMocks = () => {
  mockExistsSync.mockReturnValue(false);
  mockExecFileSync.mockImplementation(() => {
    throw new Error('no ldconfig');
  });
};

beforeEach(async () => {
  // Reset per-test so state doesn't leak
  mockExistsSync.mockReset();
  mockExecFileSync.mockReset();
  mockPipeline.mockReset();
  clearEnv();

  // Reset module-level singletons so each test gets a fresh initEmbedder.
  // Calling disposeEmbedder resets embedderInstance, currentDevice, initPromise.
  try {
    const { disposeEmbedder } = await import('../../src/core/embeddings/embedder.js');
    await disposeEmbedder();
  } catch {
    // ignore — may throw in HTTP mode or if not yet imported
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
});

// ─── initEmbedder — local pipeline path ──────────────────────────────────────

describe('initEmbedder local pipeline', () => {
  it('throws when called in HTTP mode', async () => {
    process.env.GITNEXUS_EMBEDDING_URL = 'http://localhost:8080/v1';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
    const { initEmbedder } = await import('../../src/core/embeddings/embedder.js');
    await expect(initEmbedder()).rejects.toThrow('HTTP mode');
  });

  it('loads pipeline on CPU when device is forced to cpu', async () => {
    process.env.ORT_LOG_LEVEL = '3';
    setupCpuMocks();

    mockPipeline.mockResolvedValue(
      vi.fn(() => Promise.resolve({ data: new Float32Array([0.1, 0.2, 0.3]) })),
    );

    const { initEmbedder } = await import('../../src/core/embeddings/embedder.js');
    const pipeline = await initEmbedder(undefined, { device: 'cpu' });
    expect(pipeline).toBeDefined();
    expect(mockPipeline).toHaveBeenCalledWith(
      'feature-extraction',
      'Snowflake/snowflake-arctic-embed-xs',
      expect.objectContaining({ device: 'cpu', dtype: 'fp32' }),
    );
  });

  it('favors dml on Windows even when CUDA_PATH is set', async () => {
    process.env.ORT_LOG_LEVEL = '3';
    process.env.CUDA_PATH = '/opt/cuda';
    setupCpuMocks();

    mockPipeline.mockResolvedValue(
      vi.fn(() => Promise.resolve({ data: new Float32Array([0.1, 0.2, 0.3]) })),
    );

    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const { initEmbedder } = await import('../../src/core/embeddings/embedder.js');
      await initEmbedder(undefined, { device: 'auto' });
      const callArgs = mockPipeline.mock.calls[0][2];
      expect(callArgs.device).toBe('dml');
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform!);
    }
  });

  it('falls back from GPU to CPU when GPU fails', async () => {
    // On Darwin, hasOrtCudaProvider always returns false (no linux path), so
    // isCudaAvailable() is always false and gpuDevice='cpu'. We can only test
    // the GPU→CPU fallback on Linux where CUDA is actually available.
    if (process.platform === 'darwin') {
      return;
    }

    process.env.ORT_LOG_LEVEL = '3';
    // Simulate CUDA environment: ORT has the CUDA binary + ldconfig finds cublas
    mockExistsSync.mockImplementation((p: string) =>
      String(p).includes('libonnxruntime_providers_cuda') ? true : false,
    );
    mockExecFileSync.mockReturnValue('libcublasLt.so.12');

    // GPU call fails, CPU call succeeds
    mockPipeline
      .mockRejectedValueOnce(new Error('GPU load failed'))
      .mockResolvedValueOnce(
        vi.fn(() => Promise.resolve({ data: new Float32Array([0.1, 0.2, 0.3]) })),
      );

    const { initEmbedder, getCurrentDevice } = await import('../../src/core/embeddings/embedder.js');
    await initEmbedder(undefined, { device: 'auto' });
    expect(getCurrentDevice()).toBe('cpu');
  });

  it('reports progress callback during init', async () => {
    process.env.ORT_LOG_LEVEL = '3';
    setupCpuMocks();

    const progressEvents: any[] = [];
    const progressCallback = (p: any) => progressEvents.push(p);

    // mockImplementation is the correct way to execute logic on each call;
    // mockResolvedValue only sets the resolved value without invoking any body.
    mockPipeline.mockImplementation((_task: string, _model: string, opts: any) => {
      if (opts?.progress_callback) {
        opts.progress_callback({ status: 'loading', progress: 50 });
      }
      return Promise.resolve({ data: new Float32Array([0.1, 0.2, 0.3]) });
    });

    const { initEmbedder } = await import('../../src/core/embeddings/embedder.js');
    await initEmbedder(progressCallback, { device: 'cpu' });

    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents[0]).toHaveProperty('status');
  });
});

// ─── getEmbedder ─────────────────────────────────────────────────────────────

describe('getEmbedder', () => {
  it('throws when embedder is not initialized', async () => {
    setupCpuMocks();
    const { getEmbedder } = await import('../../src/core/embeddings/embedder.js');
    expect(() => getEmbedder()).toThrow('not initialized');
  });
});

// ─── disposeEmbedder ─────────────────────────────────────────────────────────

describe('disposeEmbedder', () => {
  it('resolves without error when embedder is not initialized', async () => {
    const { disposeEmbedder } = await import('../../src/core/embeddings/embedder.js');
    await expect(disposeEmbedder()).resolves.toBeUndefined();
  });

  it('can be called multiple times without error', async () => {
    process.env.ORT_LOG_LEVEL = '3';
    setupCpuMocks();

    mockPipeline.mockResolvedValue(
      vi.fn(() => Promise.resolve({ data: new Float32Array([0.1, 0.2, 0.3]) })),
    );

    const { initEmbedder, disposeEmbedder } = await import('../../src/core/embeddings/embedder.js');
    await initEmbedder(undefined, { device: 'cpu' });
    await disposeEmbedder();
    await expect(disposeEmbedder()).resolves.toBeUndefined();
  });
});

// ─── embedText — local pipeline path ─────────────────────────────────────────

describe('embedText local pipeline', () => {
  it('returns Float32Array from local pipeline', async () => {
    process.env.ORT_LOG_LEVEL = '3';
    setupCpuMocks();

    mockPipeline.mockResolvedValue(
      vi.fn(() => Promise.resolve({ data: new Float32Array([0.1, 0.2, 0.3]) })),
    );

    const { initEmbedder, embedText } = await import('../../src/core/embeddings/embedder.js');
    await initEmbedder(undefined, { device: 'cpu' });
    const result = await embedText('test input');

    expect(result).toBeInstanceOf(Float32Array);
    expect(result).toHaveLength(3);
  });

  it('passes pooling and normalize options to the pipeline', async () => {
    process.env.ORT_LOG_LEVEL = '3';
    setupCpuMocks();

    const pipelineFn = vi.fn(() => Promise.resolve({ data: new Float32Array([0.1, 0.2, 0.3]) }));
    mockPipeline.mockResolvedValue(pipelineFn);

    const { initEmbedder, embedText } = await import('../../src/core/embeddings/embedder.js');
    await initEmbedder(undefined, { device: 'cpu' });
    await embedText('test input');

    // embedText calls: embedder(text, { pooling: 'mean', normalize: true })
    expect(pipelineFn).toHaveBeenCalledWith(
      'test input',
      expect.objectContaining({ pooling: 'mean', normalize: true }),
    );
  });
});

// ─── embedBatch — local pipeline path ────────────────────────────────────────

describe('embedBatch local pipeline', () => {
  it('returns empty array for empty input without calling pipeline', async () => {
    const { embedBatch } = await import('../../src/core/embeddings/embedder.js');
    const result = await embedBatch([]);
    expect(result).toEqual([]);
    expect(mockPipeline).not.toHaveBeenCalled();
  });

  it('returns array of Float32Arrays for batched input', async () => {
    process.env.ORT_LOG_LEVEL = '3';
    setupCpuMocks();

    // 2 texts × 3 dimensions = 6 floats
    mockPipeline.mockResolvedValue(
      vi.fn(() => Promise.resolve({ data: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) })),
    );

    const { initEmbedder, embedBatch } = await import('../../src/core/embeddings/embedder.js');
    await initEmbedder(undefined, { device: 'cpu', dimensions: 3 });
    const results = await embedBatch(['text a', 'text b']);

    expect(results).toHaveLength(2);
    expect(results[0]).toBeInstanceOf(Float32Array);
    expect(results[1]).toBeInstanceOf(Float32Array);
  });
});

// ─── embeddingToArray ─────────────────────────────────────────────────────────

describe('embeddingToArray', () => {
  it('converts Float32Array to number array', async () => {
    const { embeddingToArray } = await import('../../src/core/embeddings/embedder.js');
    const vec = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const result = embeddingToArray(vec);
    expect(result).toHaveLength(4);
    result.forEach((v, i) => expect(v).toBeCloseTo([0.1, 0.2, 0.3, 0.4][i]));
  });

  it('handles empty Float32Array', async () => {
    const { embeddingToArray } = await import('../../src/core/embeddings/embedder.js');
    const result = embeddingToArray(new Float32Array([]));
    expect(result).toEqual([]);
  });
});

// ─── getCurrentDevice ─────────────────────────────────────────────────────────

describe('getCurrentDevice', () => {
  it('returns cpu before initialization', async () => {
    setupCpuMocks();
    const { disposeEmbedder, getCurrentDevice } = await import(
      '../../src/core/embeddings/embedder.js'
    );
    await disposeEmbedder();
    expect(getCurrentDevice()).toBe('cpu');
  });

  it('returns the active device after initEmbedder', async () => {
    process.env.ORT_LOG_LEVEL = '3';
    setupCpuMocks();

    mockPipeline.mockResolvedValue(
      vi.fn(() => Promise.resolve({ data: new Float32Array([0.1, 0.2, 0.3]) })),
    );

    const { initEmbedder, getCurrentDevice } = await import('../../src/core/embeddings/embedder.js');
    await initEmbedder(undefined, { device: 'cpu' });
    expect(getCurrentDevice()).toBe('cpu');
  });
});

// ─── getEmbeddingDimensions ───────────────────────────────────────────────────

describe('getEmbeddingDimensions in local mode', () => {
  it('returns DEFAULT_EMBEDDING_CONFIG.dimensions when HTTP mode is off', async () => {
    const { getEmbeddingDimensions } = await import('../../src/core/embeddings/embedder.js');
    expect(getEmbeddingDimensions()).toBe(384);
  });
});
