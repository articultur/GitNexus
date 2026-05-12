/**
 * Objective-C call extraction config.
 *
 * ObjC uses message sends: [receiver selector:arg1 key2:arg2]
 * tree-sitter-objc represents these as `message_expression` nodes.
 * The generic path handles `call_expression` (C-level function calls).
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { CallExtractionConfig, ExtractedCallSite } from '../../call-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

function extractObjCMessageSend(callNode: SyntaxNode): ExtractedCallSite | null {
  if (callNode.type !== 'message_expression') return null;

  // message_expression: [receiver selector] or [receiver keyword:arg ...]
  // In tree-sitter-objc the selector can be:
  //   - identifier (unary message): [obj description]
  //   - keyword_expression / message_keyword for multi-arg: [obj setFoo:bar]
  let calledName = callNode.childForFieldName('method')?.text;
  const receiver = callNode.childForFieldName('receiver');
  for (let i = 0; i < callNode.namedChildCount; i++) {
    if (calledName) break;
    const child = callNode.namedChild(i);
    if (!child) continue;
    if (receiver && child.id === receiver.id) continue;
    if (child.type === 'identifier') {
      calledName = child.text;
      break;
    }
    // keyword_argument_list contains the selector parts
    if (child.type === 'keyword_argument_list') {
      const first = child.firstNamedChild;
      if (first) {
        const text = first.text;
        const colonIdx = text.indexOf(':');
        calledName = colonIdx >= 0 ? text.substring(0, colonIdx) : text;
      }
      break;
    }
  }

  if (!calledName) return null;

  // Extract receiver for member call form
  const receiverName = receiver?.type === 'identifier' ? receiver.text : undefined;

  return {
    calledName,
    callForm: receiverName ? 'member' : 'free',
    ...(receiverName ? { receiverName } : {}),
  };
}

export const objcCallConfig: CallExtractionConfig = {
  language: SupportedLanguages.ObjectiveC,
  extractLanguageCallSite: extractObjCMessageSend,
};
