import { SupportedLanguages } from 'gitnexus-shared';
import { extractVueScript } from './vue-sfc-extractor.js';
import { preprocessArktsContent } from './languages/arkts-preprocess.js';
import { preprocessObjcContent } from './languages/objc-preprocess.js';

export interface PreparedParseContent {
  parseContent: string;
  lineOffset: number;
  isVueSetup: boolean;
}

/**
 * Normalize file content into the text that should be sent to tree-sitter.
 * Returns null when the file should be skipped entirely (for example, a Vue
 * SFC without any script block).
 */
export function prepareParseContent(
  language: SupportedLanguages,
  fileContent: string,
): PreparedParseContent | null {
  let parseContent = fileContent;
  let lineOffset = 0;
  let isVueSetup = false;

  if (language === SupportedLanguages.Vue) {
    const extracted = extractVueScript(fileContent);
    if (!extracted) return null;
    parseContent = extracted.scriptContent;
    lineOffset = extracted.lineOffset;
    isVueSetup = extracted.isSetup;
  }

  if (language === SupportedLanguages.ObjectiveC) {
    parseContent = preprocessObjcContent(parseContent);
  } else if (language === SupportedLanguages.ArkTS) {
    parseContent = preprocessArktsContent(parseContent);
  }

  return { parseContent, lineOffset, isVueSetup };
}
