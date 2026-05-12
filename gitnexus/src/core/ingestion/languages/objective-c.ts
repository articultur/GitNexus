import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as objcTypeConfig } from '../type-extractors/objective-c.js';
import { cCppExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { objcImportConfig } from '../import-resolvers/configs/objective-c.js';
import { extractObjCNamedBindings } from '../named-bindings/objective-c.js';
import { OBJECTIVEC_QUERIES } from '../tree-sitter-queries.js';
import { preprocessObjcContent } from './objc-preprocess.js';
import { isObjcInsideContainer, type SyntaxNode } from '../utils/ast-helpers.js';
import type { LanguageProvider } from '../language-provider.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { objcCallConfig } from '../call-extractors/configs/objective-c.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { objcFieldConfig } from '../field-extractors/configs/objective-c.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { objcMethodConfig } from '../method-extractors/configs/objective-c.js';
import { createHeritageExtractor } from '../heritage-extractors/generic.js';

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

const objcLabelOverride: NonNullable<LanguageProvider['labelOverride']> = (
  functionNode,
  defaultLabel,
) => {
  if (defaultLabel !== 'Function') return defaultLabel;
  return isObjcInsideContainer(functionNode) ? null : defaultLabel;
};

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
  preprocessSource: preprocessObjcContent,
  typeConfig: objcTypeConfig,
  exportChecker: cCppExportChecker,
  importResolver: createImportResolver(objcImportConfig),
  importSemantics: 'wildcard-transitive',
  mroStrategy: 'leftmost-base',
  callExtractor: createCallExtractor(objcCallConfig),
  fieldExtractor: createFieldExtractor(objcFieldConfig),
  methodExtractor: createMethodExtractor(objcMethodConfig),
  heritageExtractor: createHeritageExtractor(SupportedLanguages.ObjectiveC),
  namedBindingExtractor: extractObjCNamedBindings,
  labelOverride: objcLabelOverride,
  descriptionExtractor: objcDescriptionExtractor,
  builtInNames: OBJC_BUILT_INS,
});
