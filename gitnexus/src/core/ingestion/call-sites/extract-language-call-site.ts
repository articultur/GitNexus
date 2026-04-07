/** Non-generic @call shapes → { calledName, callForm, receiverName? } (used from call-processor / parse-worker). */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import { parseJavaMethodReference } from './java.js';

export type ParsedCallSite = {
  calledName: string;
  callForm: 'free' | 'member' | 'constructor';
  receiverName?: string;
};

/** Non-null → seed replaces @call.name; null → use @call.name + inferCallForm / extractReceiverName. */
export function extractParsedCallSite(
  language: SupportedLanguages,
  callNode: SyntaxNode,
): ParsedCallSite | null {
  switch (language) {
    case SupportedLanguages.Java:
      if (callNode.type === 'method_reference') {
        const parsed = parseJavaMethodReference(callNode);
        if (!parsed) return null;
        return {
          calledName: parsed.calledName,
          callForm: parsed.callForm,
          ...(parsed.receiverName !== undefined ? { receiverName: parsed.receiverName } : {}),
        };
      }
      return null;
    case SupportedLanguages.ObjectiveC:
      if (callNode.type === 'message_expression') {
        // The OC tree-sitter query `method: (identifier) @call.name` captures ONLY
        // the FIRST selector keyword identifier. Multi-arg selectors like
        // "canRequestImageForURL:options:context:" produce ONE match per keyword,
        // but @call.name only captures the first one.
        // So we just return the first identifier we find.
        const methodField = callNode.childForFieldName('method');
        const receiverField = callNode.childForFieldName('receiver');
        if (methodField?.type === 'identifier') {
          // Store WITHOUT trailing colon, matching definition naming.
          return {
            calledName: methodField.text,
            callForm: 'member',
            ...(receiverField ? { receiverName: receiverField.text } : {}),
          };
        }
      }
      return null;
    default:
      return null;
  }
}
