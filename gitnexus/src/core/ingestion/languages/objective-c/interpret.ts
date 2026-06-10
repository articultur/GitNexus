import type { CaptureMatch, ParsedImport, ParsedTypeBinding, TypeRef } from 'gitnexus-shared';
import { normalizeCTypeName } from '../c/interpret.js';

export function interpretObjectiveCImport(captures: CaptureMatch): ParsedImport | null {
  if (captures['@import.system'] !== undefined) return null;
  const source = captures['@import.source']?.text;
  if (source === undefined || source.length === 0) return null;
  return { kind: 'wildcard', targetRaw: source };
}

export function interpretObjectiveCTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  const name = captures['@type-binding.name']?.text;
  const type = captures['@type-binding.type']?.text;
  if (name === undefined || type === undefined) return null;

  let source: TypeRef['source'] = 'annotation';
  if (captures['@type-binding.parameter'] !== undefined) {
    source = 'parameter-annotation';
  } else if (captures['@type-binding.assignment'] !== undefined) {
    source = 'assignment-inferred';
  }

  return { boundName: name, rawTypeName: normalizeCTypeName(type), source };
}
