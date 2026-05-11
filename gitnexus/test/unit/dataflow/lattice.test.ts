/**
 * Unit tests for lattice operations
 */
import { describe, it, expect } from 'vitest';
import {
  join,
  meet,
  isLessOrEqual,
  isTainted,
  isSanitized,
  propagate,
  flowSensitiveMeet,
  bottom,
  top,
  LATTICE_ORDER,
} from '../../../src/core/ingestion/dataflow/lattice';

describe('Lattice Operations', () => {
  describe('join', () => {
    it('should return other value when joining with UNINIT (bottom)', () => {
      expect(join('UNINIT', 'TAINTED')).toBe('TAINTED');
      expect(join('CONSTANT', 'UNINIT')).toBe('CONSTANT');
      expect(join('NAC', 'UNINIT')).toBe('NAC');
    });

    it('should return NAC when joining with NAC (top)', () => {
      expect(join('NAC', 'CONSTANT')).toBe('NAC');
      expect(join('TAINTED', 'NAC')).toBe('NAC');
      expect(join('NAC', 'NAC')).toBe('NAC');
    });

    it('should return NAC when joining two different non-uninit values', () => {
      expect(join('TAINTED', 'SANITIZED')).toBe('NAC');
      expect(join('CONSTANT', 'TAINTED')).toBe('NAC');
      expect(join('CONSTANT', 'SANITIZED')).toBe('NAC');
    });

    it('should return same value when joining identical values', () => {
      expect(join('CONSTANT', 'CONSTANT')).toBe('CONSTANT');
      expect(join('TAINTED', 'TAINTED')).toBe('TAINTED');
      expect(join('SANITIZED', 'SANITIZED')).toBe('SANITIZED');
    });

    it('should be commutative', () => {
      expect(join('TAINTED', 'CONSTANT')).toBe(join('CONSTANT', 'TAINTED'));
      expect(join('TAINTED', 'SANITIZED')).toBe(join('SANITIZED', 'TAINTED'));
    });

    it('should be associative', () => {
      const result1 = join(join('CONSTANT', 'TAINTED'), 'SANITIZED');
      const result2 = join('CONSTANT', join('TAINTED', 'SANITIZED'));
      expect(result1).toBe(result2);
    });
  });

  describe('meet', () => {
    it('should return other value when meeting with NAC (top)', () => {
      expect(meet('NAC', 'CONSTANT')).toBe('CONSTANT');
      expect(meet('TAINTED', 'NAC')).toBe('TAINTED');
    });

    it('should return UNINIT when meeting with UNINIT (bottom)', () => {
      expect(meet('UNINIT', 'TAINTED')).toBe('UNINIT');
      expect(meet('CONSTANT', 'UNINIT')).toBe('UNINIT');
    });

    it('should return NAC when meeting inconsistent values', () => {
      expect(meet('CONSTANT', 'TAINTED')).toBe('NAC');
      expect(meet('CONSTANT', 'SANITIZED')).toBe('NAC');
    });

    it('should return same value when meeting identical values', () => {
      expect(meet('CONSTANT', 'CONSTANT')).toBe('CONSTANT');
      expect(meet('TAINTED', 'TAINTED')).toBe('TAINTED');
    });
  });

  describe('isLessOrEqual', () => {
    it('should return true for UNINIT <= anything', () => {
      expect(isLessOrEqual('UNINIT', 'UNINIT')).toBe(true);
      expect(isLessOrEqual('UNINIT', 'CONSTANT')).toBe(true);
      expect(isLessOrEqual('UNINIT', 'TAINTED')).toBe(true);
      expect(isLessOrEqual('UNINIT', 'NAC')).toBe(true);
    });

    it('should return false for anything > UNINIT <= NAC', () => {
      expect(isLessOrEqual('CONSTANT', 'UNINIT')).toBe(false);
      expect(isLessOrEqual('NAC', 'TAINTED')).toBe(false);
    });

    it('should return true for same values', () => {
      expect(isLessOrEqual('CONSTANT', 'CONSTANT')).toBe(true);
      expect(isLessOrEqual('TAINTED', 'TAINTED')).toBe(true);
    });
  });

  describe('isTainted', () => {
    it('should return true only for TAINTED', () => {
      expect(isTainted('TAINTED')).toBe(true);
      expect(isTainted('CONSTANT')).toBe(false);
      expect(isTainted('SANITIZED')).toBe(false);
      expect(isTainted('UNINIT')).toBe(false);
      expect(isTainted('NAC')).toBe(false);
    });
  });

  describe('isSanitized', () => {
    it('should return true only for SANITIZED', () => {
      expect(isSanitized('SANITIZED')).toBe(true);
      expect(isSanitized('TAINTED')).toBe(false);
      expect(isSanitized('CONSTANT')).toBe(false);
    });
  });

  describe('propagate', () => {
    it('should propagate UNINIT as UNINIT', () => {
      expect(propagate('UNINIT')).toBe('UNINIT');
    });

    it('should propagate NAC as NAC', () => {
      expect(propagate('NAC')).toBe('NAC');
    });

    it('should propagate CONSTANT as CONSTANT', () => {
      expect(propagate('CONSTANT')).toBe('CONSTANT');
    });

    it('should propagate TAINTED as TAINTED', () => {
      expect(propagate('TAINTED')).toBe('TAINTED');
    });

    it('should propagate SANITIZED as SANITIZED', () => {
      expect(propagate('SANITIZED')).toBe('SANITIZED');
    });
  });

  describe('flowSensitiveMeet', () => {
    it('should handle if/else with different branch values', () => {
      // if (cond) { x = source() } else { x = sanitize(y) }
      // then branch: x = TAINTED, else branch: x = SANITIZED
      // after if: join(TAINTED, SANITIZED) = NAC
      expect(flowSensitiveMeet('TAINTED', 'SANITIZED')).toBe('NAC');
    });

    it('should handle if/else with same branch values', () => {
      // if (cond) { x = a } else { x = b } where a = b = CONSTANT
      expect(flowSensitiveMeet('CONSTANT', 'CONSTANT')).toBe('CONSTANT');
    });

    it('should handle if/else with uninitialized paths', () => {
      // if (cond) { x = source() } else { /* x not defined */ }
      // then: x = TAINTED, else: x = UNINIT
      // after if: join(TAINTED, UNINIT) = TAINTED
      expect(flowSensitiveMeet('TAINTED', 'UNINIT')).toBe('TAINTED');
    });
  });

  describe('LATTICE_ORDER', () => {
    it('should have UNINIT as lowest (0)', () => {
      expect(LATTICE_ORDER['UNINIT']).toBe(0);
    });

    it('should have NAC as highest (3)', () => {
      expect(LATTICE_ORDER['NAC']).toBe(3);
    });

    it('should have CONSTANT, TAINTED, SANITIZED in middle', () => {
      expect(LATTICE_ORDER['CONSTANT']).toBe(1);
      expect(LATTICE_ORDER['TAINTED']).toBe(2);
      expect(LATTICE_ORDER['SANITIZED']).toBe(2);
    });
  });

  describe('bottom and top', () => {
    it('should return UNINIT for bottom()', () => {
      expect(bottom()).toBe('UNINIT');
    });

    it('should return NAC for top()', () => {
      expect(top()).toBe('NAC');
    });
  });
});
