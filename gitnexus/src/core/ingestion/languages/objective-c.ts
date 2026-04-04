/**
 * Objective-C and Objective-C++ language providers.
 *
 * Both use the same tree-sitter-objc grammar (Obj-C grammar is a superset that
 * also handles C++/Objective-C++ via #ifdef __OBJC__ guards in headers).
 *
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

import { isObjcInsideContainer, type SyntaxNode } from '../utils/ast-helpers.js';
import type { LanguageProvider } from '../language-provider.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { objcConfig } from '../field-extractors/configs/objc.js';

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
  'NULL',
  'nil',
  'Class',
  'SEL',
  'IMP',
  'Method',
  'Ivar',
  'objc_property_t',
  'Protocol',
  'object_getClass',
  'class_getName',
  'class_getSuperclass',
  'class_addMethod',
  'class_replaceMethod',
  'method_getName',
  'method_getImplementation',
  'sel_getName',
  'sel_registerName',
  'objc_msgSend',
  'objc_msgSendSuper',
  'objc_storeStrong',
  'objc_loadWeak',
  'objc_initWeak',
  'objc_destroyWeak',
  'CFArray',
  'CFDictionary',
  'CFString',
  'CFNumber',
  'CFBoolean',
  'kCFBooleanTrue',
  'kCFBooleanFalse',
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

/** Extract full OC method selector name from the method declaration node.
 * OC method selectors consist of multiple keyword parts: "sizeOfView:css:attribute:".
 * The AST node structure for `- (CGSize)sizeOfView:(id)view css:(NSDictionary *)c`
 * is a flat sequence: method_type | identifier (selector) | method_parameter |
 * identifier (selector) | method_parameter | ...
 * Selector keyword identifiers are those followed by a ':' token in the child list.
 * Returns undefined to leave nodeName unchanged (pipeline uses @name capture). */
const objcDescriptionExtractor: NonNullable<LanguageProvider['descriptionExtractor']> = (
  nodeLabel,
  _nodeName,
  captureMap,
) => {
  if (nodeLabel !== 'Method') return undefined;
  const defNode = captureMap['definition.method'];
  if (!defNode) return undefined;

  // Collect all selector keyword identifiers from the method children.
  // In OC grammar, method_declaration children are a flat sequence:
  //   "-" | method_type | identifier (sel) | method_parameter | identifier (sel) | method_parameter | ...
  // The ":" colon lives INSIDE method_parameter as its first child.
  // A selector keyword identifier is one whose nextSibling is method_parameter (or ";")
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

  // If no selector parts found (unary method with no ':'), return undefined
  if (parts.length === 0) return undefined;
  return parts.join(':') + ':';
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
  labelOverride: objcLabelOverride,
  descriptionExtractor: objcDescriptionExtractor,
  builtInNames: OBJC_BUILT_INS,
});
