/**
 * Dataflow explanation tool — LLM-powered taint path explanations.
 */

import { resolveLLMConfig, callLLM } from '../../../core/wiki/llm-client.js';
import type { RepoHandle } from './shared.js';

export async function explainDataflowTool(
  _repo: RepoHandle,
  params: { taint_path: string },
): Promise<{ explanation: string; raw?: string }> {
  let taintPath: any;
  try {
    taintPath = JSON.parse(params.taint_path);
  } catch {
    return {
      explanation:
        'Invalid taint_path JSON. Expected: { source, sink, path, sanitizers, confidence }',
    };
  }

  const { source, sink, path = [], sanitizers = [], confidence = 0 } = taintPath;

  const pathSteps = path.map((s: any) => `  - ${s.from} --[${s.operation}]--> ${s.to}`).join('\n');

  const sanitizerList = sanitizers.length
    ? sanitizers.map((s: any) => `  - ${s.variable} at ${s.nodeId}: ${s.description}`).join('\n')
    : '  (none)';

  const prompt = `You are a security expert explaining a data flow vulnerability.

## Source (untrusted input)
- Node: ${source?.nodeId ?? '?'}
- Variable: ${source?.variable ?? '?'}
- Kind: ${source?.kind ?? '?'}
- Description: ${source?.description ?? '?'}

## Sink (harmful destination)
- Node: ${sink?.nodeId ?? '?'}
- Variable: ${sink?.variable ?? '?'}
- Kind: ${sink?.kind ?? '?'}
- Description: ${sink?.description ?? '?'}

## Propagation path
${pathSteps || '  (path unavailable)'}

## Sanitizers on path
${sanitizerList}

## Confidence
${confidence}

Please explain in plain English:
1. What the vulnerability is and how it works
2. What an attacker could do (attack scenario)
3. How to fix or mitigate it

Be concise — 3-5 sentences maximum.`;

  try {
    const config = await resolveLLMConfig({ maxTokens: 500 });
    const result = await callLLM(prompt, config);
    return { explanation: result.content };
  } catch (err) {
    return {
      explanation:
        'LLM explanation unavailable. Check that an API key is configured (GITNEXUS_API_KEY or OPENAI_API_KEY).',
      raw: String(err),
    };
  }
}
