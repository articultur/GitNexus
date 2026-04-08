/**
 * Built-in detection rules — auto-registration barrel.
 *
 * Import this module to register all built-in rules with a RuleEngine.
 */

import type { Rule } from '../types.js';
import { missingGuardRule } from './missing-guard.js';
import { missingUnwrapRule } from './missing-unwrap.js';
import { missingResourceRule } from './missing-resource.js';
import { missingExceptionHandlingRule } from './missing-exception-handling.js';
import { missingReturnCheckRule } from './missing-return-check.js';
import { missingConcurrencyGuardRule } from './missing-concurrency-guard.js';

/** All built-in rules, in evaluation order. */
export const builtinRules: Rule[] = [
  missingGuardRule,
  missingUnwrapRule,
  missingResourceRule,
  missingExceptionHandlingRule,
  missingReturnCheckRule,
  missingConcurrencyGuardRule,
];
