/**
 * Unit tests for diff degradation functionality
 *
 * Tests the graceful degradation when git diff exceeds buffer limits (ENOBUFS).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  determinePrecision,
  formatBytes,
  getDegradationConfigFromEnv,
  mergeDegradationConfig,
  DIFF_SIZE_THRESHOLDS,
  type DegradationConfig,
} from '../../src/mcp/local/tools/shared.js';

describe('determinePrecision', () => {
  const defaultNormalMax = DIFF_SIZE_THRESHOLDS.NORMAL_MAX; // 512KB
  const defaultSymbolMax = DIFF_SIZE_THRESHOLDS.SYMBOL_LEVEL_MAX; // 2MB
  const hysteresis = DIFF_SIZE_THRESHOLDS.HYSTERESIS;

  it('should return "normal" for small diffs', () => {
    expect(determinePrecision(1024)).toBe('normal'); // 1KB
    expect(determinePrecision(100 * 1024)).toBe('normal'); // 100KB
  });

  it('should return "normal" for diffs just below threshold with hysteresis', () => {
    const justBelowNormal = defaultNormalMax * hysteresis - 1;
    expect(determinePrecision(justBelowNormal)).toBe('normal');
  });

  it('should return "symbol-level" for medium diffs', () => {
    const aboveNormal = defaultNormalMax * hysteresis + 1;
    expect(determinePrecision(aboveNormal)).toBe('symbol-level');
    expect(determinePrecision(1 * 1024 * 1024)).toBe('symbol-level'); // 1MB
  });

  it('should return "symbol-level" for diffs just below symbol threshold with hysteresis', () => {
    const justBelowSymbol = defaultSymbolMax * hysteresis - 1;
    expect(determinePrecision(justBelowSymbol)).toBe('symbol-level');
  });

  it('should return "file-level" for large diffs', () => {
    const aboveSymbol = defaultSymbolMax * hysteresis + 1;
    expect(determinePrecision(aboveSymbol)).toBe('file-level');
    expect(determinePrecision(5 * 1024 * 1024)).toBe('file-level'); // 5MB
  });

  it('should respect custom config', () => {
    const config: DegradationConfig = {
      normalMaxBytes: 100 * 1024, // 100KB
      symbolLevelMaxBytes: 500 * 1024, // 500KB
    };

    expect(determinePrecision(50 * 1024, config)).toBe('normal');
    expect(determinePrecision(150 * 1024, config)).toBe('symbol-level');
    expect(determinePrecision(600 * 1024, config)).toBe('file-level');
  });

  it('should apply hysteresis to custom thresholds', () => {
    const config: DegradationConfig = {
      normalMaxBytes: 100 * 1024, // 100KB
    };

    // Just below hysteresis threshold (95KB) should be normal
    expect(determinePrecision(94 * 1024, config)).toBe('normal');

    // Just above hysteresis threshold should be symbol-level
    expect(determinePrecision(96 * 1024, config)).toBe('symbol-level');
  });
});

describe('formatBytes', () => {
  it('should format 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('should format bytes', () => {
    expect(formatBytes(512)).toBe('512.00 B');
  });

  it('should format kilobytes', () => {
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(512 * 1024)).toBe('512.00 KB');
  });

  it('should format megabytes', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.50 MB');
  });

  it('should format gigabytes', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
  });
});

describe('getDegradationConfigFromEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment for each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return empty config when no env vars set', () => {
    delete process.env.GITNEXUS_DIFF_NORMAL_MAX;
    delete process.env.GITNEXUS_DIFF_SYMBOL_MAX;
    delete process.env.GITNEXUS_DIFF_DISABLE_SYMBOL_LEVEL;

    const config = getDegradationConfigFromEnv();
    expect(config).toEqual({});
  });

  it('should read GITNEXUS_DIFF_NORMAL_MAX', () => {
    process.env.GITNEXUS_DIFF_NORMAL_MAX = '1048576'; // 1MB

    const config = getDegradationConfigFromEnv();
    expect(config.normalMaxBytes).toBe(1048576);
  });

  it('should read GITNEXUS_DIFF_SYMBOL_MAX', () => {
    process.env.GITNEXUS_DIFF_SYMBOL_MAX = '4194304'; // 4MB

    const config = getDegradationConfigFromEnv();
    expect(config.symbolLevelMaxBytes).toBe(4194304);
  });

  it('should handle invalid values gracefully', () => {
    process.env.GITNEXUS_DIFF_NORMAL_MAX = 'invalid';
    process.env.GITNEXUS_DIFF_SYMBOL_MAX = '-100';

    const config = getDegradationConfigFromEnv();
    expect(config.normalMaxBytes).toBeUndefined();
    expect(config.symbolLevelMaxBytes).toBeUndefined();
  });

  it('should read GITNEXUS_DIFF_DISABLE_SYMBOL_LEVEL', () => {
    process.env.GITNEXUS_DIFF_DISABLE_SYMBOL_LEVEL = '1';

    const config = getDegradationConfigFromEnv();
    expect(config.enableSymbolLevel).toBe(false);
  });

  it('should handle "true" for disable symbol level', () => {
    process.env.GITNEXUS_DIFF_DISABLE_SYMBOL_LEVEL = 'true';

    const config = getDegradationConfigFromEnv();
    expect(config.enableSymbolLevel).toBe(false);
  });
});

describe('mergeDegradationConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should use env vars as defaults', () => {
    process.env.GITNEXUS_DIFF_NORMAL_MAX = '1048576';

    const config = mergeDegradationConfig();
    expect(config.normalMaxBytes).toBe(1048576);
  });

  it('should let explicit config override env vars', () => {
    process.env.GITNEXUS_DIFF_NORMAL_MAX = '1048576';

    const config = mergeDegradationConfig({ normalMaxBytes: 2097152 });
    expect(config.normalMaxBytes).toBe(2097152);
  });

  it('should merge partial configs', () => {
    process.env.GITNEXUS_DIFF_NORMAL_MAX = '1048576';
    process.env.GITNEXUS_DIFF_SYMBOL_MAX = '4194304';

    const config = mergeDegradationConfig({ normalMaxBytes: 2097152 });
    expect(config.normalMaxBytes).toBe(2097152); // from explicit
    expect(config.symbolLevelMaxBytes).toBe(4194304); // from env
  });

  it('should handle undefined explicit config', () => {
    process.env.GITNEXUS_DIFF_NORMAL_MAX = '1048576';

    const config = mergeDegradationConfig(undefined);
    expect(config.normalMaxBytes).toBe(1048576);
  });
});

describe('DIFF_SIZE_THRESHOLDS', () => {
  it('should have correct default values', () => {
    expect(DIFF_SIZE_THRESHOLDS.NORMAL_MAX).toBe(512 * 1024); // 512KB
    expect(DIFF_SIZE_THRESHOLDS.SYMBOL_LEVEL_MAX).toBe(2 * 1024 * 1024); // 2MB
    expect(DIFF_SIZE_THRESHOLDS.HYSTERESIS).toBe(0.95);
  });
});
