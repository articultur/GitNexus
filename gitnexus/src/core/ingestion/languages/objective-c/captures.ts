import type { Capture, CaptureMatch } from 'gitnexus-shared';
import {
  nodeIfType,
  nodeToCapture,
  syntheticCapture,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { getObjectiveCParser, getObjectiveCScopeQuery } from './query.js';

export function emitObjectiveCScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree = cachedTree as ReturnType<ReturnType<typeof getObjectiveCParser>['parse']> | undefined;
  if (tree === undefined) {
    tree = parseSourceSafe(getObjectiveCParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
  }

  const rawMatches = getObjectiveCScopeQuery().matches(tree.rootNode);
  const out: CaptureMatch[] = [];

  for (const match of rawMatches) {
    const grouped: Record<string, Capture> = {};
    const nodeMap: Record<string, SyntaxNode> = {};
    for (const capture of match.captures) {
      const tag = `@${capture.name}`;
      grouped[tag] = nodeToCapture(tag, capture.node);
      nodeMap[tag] = capture.node;
    }
    if (Object.keys(grouped).length === 0) continue;

    if (grouped['@import.statement'] !== undefined) {
      const includeNode = nodeIfType(nodeMap['@import.statement'], 'preproc_include');
      const pathNode = includeNode?.childForFieldName('path') ?? null;
      if (includeNode !== null && pathNode !== null) {
        const raw = pathNode.text;
        const isSystem = raw.startsWith('<') && raw.endsWith('>');
        const targetRaw = raw.replace(/^["<]/, '').replace(/[">]$/, '');
        grouped['@import.source'] = syntheticCapture('@import.source', pathNode, targetRaw);
        if (isSystem) grouped['@import.system'] = syntheticCapture('@import.system', pathNode, '1');
      }
    }

    if (grouped['@reference.call.member'] !== undefined) {
      const msgNode = nodeIfType(nodeMap['@reference.call.member'], 'message_expression');
      if (msgNode !== null) {
        const receiverNode = msgNode.childForFieldName('receiver');
        const receiverText = normalizeReceiver(receiverNode);
        if (receiverText !== null) {
          grouped['@reference.receiver'] = syntheticCapture(
            '@reference.receiver',
            receiverNode ?? msgNode,
            receiverText,
          );
        }
        if (grouped['@reference.arity'] === undefined) {
          grouped['@reference.arity'] = syntheticCapture(
            '@reference.arity',
            msgNode,
            String(computeMessageArity(msgNode)),
          );
        }
      }
    }

    out.push(grouped);
  }

  return out;
}

function normalizeReceiver(receiverNode: SyntaxNode | null | undefined): string | null {
  if (receiverNode === null || receiverNode === undefined) return null;
  if (receiverNode.type === 'identifier')
    return receiverNode.text === 'self' ? 'this' : receiverNode.text;
  if (receiverNode.type === 'message_expression') {
    const nestedReceiver = receiverNode.childForFieldName('receiver');
    return normalizeReceiver(nestedReceiver);
  }
  return receiverNode.text;
}

function computeMessageArity(messageNode: SyntaxNode): number {
  let count = 0;
  const receiver = messageNode.childForFieldName('receiver');
  const method = messageNode.childForFieldName('method');
  for (let i = 0; i < messageNode.namedChildCount; i++) {
    const child = messageNode.namedChild(i);
    if (child === null) continue;
    if (receiver !== null && child.id === receiver.id) continue;
    if (method !== null && child.id === method.id) continue;
    if (child.type === 'identifier') continue;
    count++;
  }
  return count;
}
