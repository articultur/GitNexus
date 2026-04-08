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
import { sqlInjectionRule } from './sql-injection.js';
import { pathTraversalRule } from './path-traversal.js';
import { xssRule } from './xss.js';

/** All built-in rules, in evaluation order. */
export const builtinRules: Rule[] = [
  missingGuardRule,
  missingUnwrapRule,
  missingResourceRule,
  missingExceptionHandlingRule,
  missingReturnCheckRule,
  missingConcurrencyGuardRule,
  sqlInjectionRule,
  pathTraversalRule,
  xssRule,
];
