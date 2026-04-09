/**
 * Objective-C language provider.
 *
 * Both .m and .mm files use the tree-sitter-objc grammar.
 * Import semantics are wildcard (via #import, which is semantically equivalent
 * to #include with header guard deduplication).
 *
 * OC has three container types: @interface, @implementation, @protocol.
 * MRO is 'leftmost-base' for the same reasons as C++.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as objcTypeConfig } from '../type-extractors/objective-c.js';
import { cCppExportChecker } from '../export-detection.js';
import { resolveCppImport } from '../import-resolvers/standard.js';
import { OBJECTIVEC_QUERIES } from '../tree-sitter-queries.js';
import { extractObjCNamedBindings } from '../named-bindings/objective-c.js';

import { isObjcInsideContainer, type SyntaxNode } from '../utils/ast-helpers.js';
import type { LanguageProvider } from '../language-provider.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { objcConfig } from '../field-extractors/configs/objc.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { objcMethodConfig } from '../method-extractors/configs/objc.js';

const OBJC_BUILT_INS: ReadonlySet<string> = new Set([
  'alloc',
  'init',
  'dealloc',
  'retain',
  'release',
  'autorelease',
  'retainCount',
  'copy',
  'mutableCopy',
  'new',
  'class',
  'super',
  'self',
  '_cmd',
  'YES',
  'NO',
  'nil',
  'NULL',
  'NSObject',
  'NSString',
  'NSArray',
  'NSMutableArray',
  'NSDictionary',
  'NSMutableDictionary',
  'NSSet',
  'NSMutableSet',
  'NSNumber',
  'NSData',
  'NSMutableData',
  'NSDate',
  'NSError',
  'NSException',
  'NSLog',
  'NSAssert',
  'NSParameterAssert',
  'typeof',
  'sizeof',
  'Class',
  'SEL',
  'IMP',
  'Method',
  'Ivar',
  'Protocol',
  'objc_msgSend',
  'objc_msgSendSuper',
]);

/** Label override for OC: skip function_definition captures inside @interface/@implementation/@protocol
 *  bodies (they're duplicates of definition.method captures). */
const objcLabelOverride: NonNullable<LanguageProvider['labelOverride']> = (
  functionNode,
  defaultLabel,
) => {
  if (defaultLabel !== 'Function') return defaultLabel;
  return isObjcInsideContainer(functionNode) ? null : defaultLabel;
};

/** Extract full OC method selector name from the method declaration node. */
const objcDescriptionExtractor: NonNullable<LanguageProvider['descriptionExtractor']> = (
  nodeLabel,
  _nodeName,
  captureMap,
) => {
  if (nodeLabel !== 'Method') return undefined;
  const defNode = captureMap['definition.method'];
  if (!defNode) return undefined;

  const parts: string[] = [];
  let child: SyntaxNode | null = defNode.firstChild;
  while (child) {
    if (child.type === 'identifier') {
      const next = child.nextSibling;
      if (next && (next.type === 'method_parameter' || next.type === ';')) {
        parts.push(child.text);
      }
    }
    child = child.nextSibling;
  }

  if (parts.length === 0) return undefined;
  return parts[0];
};

export const objectiveCProvider = defineLanguage({
  id: SupportedLanguages.ObjectiveC,
  extensions: ['.m', '.mm'],
  treeSitterQueries: OBJECTIVEC_QUERIES,
  typeConfig: objcTypeConfig,
  exportChecker: cCppExportChecker,
  importResolver: resolveCppImport,
  importSemantics: 'wildcard',
  mroStrategy: 'leftmost-base',
  fieldExtractor: createFieldExtractor(objcConfig),
  methodExtractor: createMethodExtractor(objcMethodConfig),
  namedBindingExtractor: extractObjCNamedBindings,
  labelOverride: objcLabelOverride,
  descriptionExtractor: objcDescriptionExtractor,
  builtInNames: OBJC_BUILT_INS,
});
