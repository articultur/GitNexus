/**
 * Shared taint analysis infrastructure.
 *
 * Taint analysis tracks: SOURCE → PROPAGATION → SANITIZER → SINK
 * This module provides:
 *  - TaintConfig: per-language source/sanitizer/sink patterns
 *  - TaintAnnotation: propagated taint metadata
 *  - TAINT_CONFIGS: language-to-pattern registry for dataflow analysis
 */

// ── Taint annotation types ────────────────────────────────────────────────────

/** Represents taint propagation through a PendingAssignment chain. */
export interface TaintAnnotation {
  /** Taint sources that have propagated to this variable */
  sources: Set<string>;
  /** True if this variable has been sanitized */
  sanitized: boolean;
}

/** Discriminated union for taint analysis results from a node. */
export type TaintResult =
  | { kind: 'source'; name: string; description: string }
  | { kind: 'sanitizer'; name: string; description: string }
  | { kind: 'sink'; name: string; description: string }
  | undefined;

// ── Taint configuration per language ────────────────────────────────────────

export interface TaintPattern {
  /** Pattern name shown in reason string */
  name: string;
  /** Human-readable description */
  description: string;
}

export interface TaintConfig {
  /** AST node types that represent taint sources for this language */
  sourceNodeTypes: ReadonlySet<string>;
  /** (varName) → TaintPattern if the declaration is a taint source */
  extractSourceDeclaration: (node: SyntaxNode) => TaintPattern | undefined;
  /** AST node types that represent sink calls for this language */
  sinkNodeTypes: ReadonlySet<string>;
  /** (node) → TaintPattern if the call expression is a sink */
  extractSinkCall: (node: SyntaxNode) => TaintPattern | undefined;
  /** AST node types that represent sanitizer calls for this language */
  sanitizerNodeTypes: ReadonlySet<string>;
  /** (node) → TaintPattern if the call expression is a sanitizer */
  extractSanitizerCall: (node: SyntaxNode) => TaintPattern | undefined;
}

import type { SyntaxNode } from '../utils/ast-helpers.js';

// ── Java taint patterns ─────────────────────────────────────────────────────

const JAVA_SINK_METHODS = new Set([
  'execute',
  'executeQuery',
  'executeUpdate',
  'executeLargeUpdate',
  'exec',
  'execSync',
  'eval',
]);

const JAVA_SANITIZER_METHODS = new Set([
  'escape',
  'sanitize',
  'htmlEscape',
  'encodeForHTML',
  'encodeForURL',
  'trim',
  'strip',
  'stripLeading',
  'stripTrailing',
]);

/** Java: request.getParameter("x") — source node is method_invocation with named arg */
function javaTaintSource(node: SyntaxNode): TaintPattern | undefined {
  // Pattern: method_invocation on identifier "request" / "params" / "query"
  const obj = node.childForFieldName('object');
  const name = node.childForFieldName('name');
  if (!obj || !name) return undefined;
  const objName = obj.type === 'identifier' ? obj.text : undefined;
  const methodName = name.text;
  if (objName === 'request' || objName === 'params' || objName === 'query') {
    if (['getParameter', 'getHeader', 'getQuery', 'getBody'].includes(methodName)) {
      return { name: 'java-request-input', description: `HTTP request input: ${methodName}()` };
    }
  }
  if (objName === 'System' && methodName === 'getenv') {
    return { name: 'java-env', description: 'Environment variable access' };
  }
  return undefined;
}

function javaTaintSink(node: SyntaxNode): TaintPattern | undefined {
  const name = node.childForFieldName('name');
  if (!name) return undefined;
  const methodName = name.text;
  if (JAVA_SINK_METHODS.has(methodName)) {
    return { name: `java-sink:${methodName}`, description: `Dangerous method: ${methodName}()` };
  }
  // Class.forName(...) — dynamic class loading
  if (methodName === 'forName') {
    return { name: 'java-sink:forName', description: 'Dynamic class loading via Class.forName()' };
  }
  return undefined;
}

function javaTaintSanitizer(node: SyntaxNode): TaintPattern | undefined {
  const name = node.childForFieldName('name');
  if (!name) return undefined;
  const methodName = name.text;
  if (JAVA_SANITIZER_METHODS.has(methodName)) {
    return {
      name: `java-sanitizer:${methodName}`,
      description: `Sanitizer method: ${methodName}()`,
    };
  }
  return undefined;
}

export const javaTaintConfig: TaintConfig = {
  sourceNodeTypes: new Set(['method_invocation']),
  extractSourceDeclaration: () => undefined,
  sinkNodeTypes: new Set(['method_invocation', 'class_literal']),
  extractSinkCall: javaTaintSink,
  sanitizerNodeTypes: new Set(['method_invocation']),
  extractSanitizerCall: javaTaintSanitizer,
};

// ── Kotlin taint patterns ──────────────────────────────────────────────────

const KOTLIN_SINK_METHODS = new Set(['exec', 'eval', 'forName']);

function kotlinTaintSource(node: SyntaxNode): TaintPattern | undefined {
  const obj = node.childForFieldName('object');
  const name = node.childForFieldName('name');
  if (!obj || !name) return undefined;
  const objName = obj.type === 'simple_identifier' ? obj.text : undefined;
  const methodName = name.text;
  if (objName === 'request' || objName === 'params') {
    if (['getParameter', 'getHeader', 'queryParameters'].includes(methodName)) {
      return { name: 'kotlin-request-input', description: `HTTP request input: ${methodName}()` };
    }
  }
  if (methodName === 'getenv') {
    return { name: 'kotlin-env', description: 'Environment variable access' };
  }
  return undefined;
}

function kotlinTaintSink(node: SyntaxNode): TaintPattern | undefined {
  const name = node.childForFieldName('name');
  if (!name) return undefined;
  const methodName = name.text;
  if (KOTLIN_SINK_METHODS.has(methodName)) {
    return { name: `kotlin-sink:${methodName}`, description: `Dangerous method: ${methodName}()` };
  }
  return undefined;
}

function kotlinTaintSanitizer(node: SyntaxNode): TaintPattern | undefined {
  return javaTaintSanitizer(node);
}

export const kotlinTaintConfig: TaintConfig = {
  sourceNodeTypes: new Set(['method_invocation']),
  extractSourceDeclaration: () => undefined,
  sinkNodeTypes: new Set(['method_invocation']),
  extractSinkCall: kotlinTaintSink,
  sanitizerNodeTypes: new Set(['method_invocation']),
  extractSanitizerCall: kotlinTaintSanitizer,
};

// ── Go taint patterns ──────────────────────────────────────────────────────

const GO_SINK_FUNCTIONS = new Set([
  'Exec',
  'Query',
  'QueryRow',
  'ExecContext',
  'Command',
  'CommandContext',
  'LookPath',
  'Eval',
  'Run',
  'Output',
]);

function goTaintSource(node: SyntaxNode): TaintPattern | undefined {
  // Go: r.FormValue, r.PostForm, r.FormFile, os.Getenv
  const sel = node.childForFieldName('selector');
  if (!sel) return undefined;
  const selName = sel.text;
  if (selName === 'FormValue' || selName === 'PostForm' || selName === 'FormFile') {
    return { name: 'go-request-input', description: `HTTP form input: ${selName}()` };
  }
  if (selName === 'Getenv') {
    return { name: 'go-env', description: 'Environment variable via os.Getenv' };
  }
  return undefined;
}

function goTaintSink(node: SyntaxNode): TaintPattern | undefined {
  const sel = node.childForFieldName('selector');
  if (!sel) return undefined;
  const fnName = sel.text;
  if (GO_SINK_FUNCTIONS.has(fnName)) {
    return { name: `go-sink:${fnName}`, description: `Dangerous function: ${fnName}()` };
  }
  return undefined;
}

function goTaintSanitizer(_node: SyntaxNode): TaintPattern | undefined {
  // database/sql parameterized queries are the primary sanitizer in Go
  return undefined;
}

export const goTaintConfig: TaintConfig = {
  sourceNodeTypes: new Set(['call_expression']),
  extractSourceDeclaration: () => undefined,
  sinkNodeTypes: new Set(['call_expression']),
  extractSinkCall: goTaintSink,
  sanitizerNodeTypes: new Set([]),
  extractSanitizerCall: goTaintSanitizer,
};

// ── Dart / Flutter taint patterns ───────────────────────────────────────────

const DART_SINK_METHODS = new Set(['execute', 'run', 'eval', 'forName']);

function dartTaintSource(node: SyntaxNode): TaintPattern | undefined {
  // Dart: request.body, request.queryParameters, stdin.readLineSync()
  const sel = node.childForFieldName('selector');
  if (!sel) return undefined;
  const methodName = sel.text;
  if (['body', 'queryParameters', 'formFields'].includes(methodName)) {
    return { name: 'dart-request-input', description: `HTTP input via ${methodName}` };
  }
  if (methodName === 'readLineSync') {
    return { name: 'dart-stdin', description: 'Standard input read' };
  }
  return undefined;
}

function dartTaintSink(node: SyntaxNode): TaintPattern | undefined {
  const sel = node.childForFieldName('selector');
  if (!sel) return undefined;
  const fnName = sel.text;
  if (DART_SINK_METHODS.has(fnName)) {
    return { name: `dart-sink:${fnName}`, description: `Dangerous method: ${fnName}()` };
  }
  return undefined;
}

function dartTaintSanitizer(_node: SyntaxNode): TaintPattern | undefined {
  return undefined;
}

export const dartTaintConfig: TaintConfig = {
  sourceNodeTypes: new Set(['method_invocation']),
  extractSourceDeclaration: () => undefined,
  sinkNodeTypes: new Set(['method_invocation']),
  extractSinkCall: dartTaintSink,
  sanitizerNodeTypes: new Set([]),
  extractSanitizerCall: dartTaintSanitizer,
};

// ── C# taint patterns ───────────────────────────────────────────────────────

const CSHARP_SINK_METHODS = new Set([
  'Execute',
  'ExecuteQuery',
  'ExecuteNonQuery',
  'Eval',
  'ProcessStart',
  'Start',
]);

function csharpTaintSource(node: SyntaxNode): TaintPattern | undefined {
  // C#: Request.Query, Request.Form, Request.Headers, Request.Cookies
  const obj = node.childForFieldName('object');
  const name = node.childForFieldName('name');
  if (!obj || !name) return undefined;
  const objName = obj.type === 'identifier' ? obj.text : undefined;
  const propName = name.text;
  if (objName === 'Request') {
    if (['Query', 'Form', 'Headers', 'Cookies', 'Params'].includes(propName)) {
      return { name: 'csharp-request-input', description: `HTTP request: Request.${propName}` };
    }
  }
  if (propName === 'Getenv' || propName === 'Environment') {
    return { name: 'csharp-env', description: 'Environment variable access' };
  }
  return undefined;
}

function csharpTaintSink(node: SyntaxNode): TaintPattern | undefined {
  const name = node.childForFieldName('name');
  if (!name) return undefined;
  const fnName = name.text;
  if (CSHARP_SINK_METHODS.has(fnName)) {
    return { name: `csharp-sink:${fnName}`, description: `Dangerous method: ${fnName}()` };
  }
  return undefined;
}

function csharpTaintSanitizer(_node: SyntaxNode): TaintPattern | undefined {
  return undefined;
}

export const csharpTaintConfig: TaintConfig = {
  sourceNodeTypes: new Set(['method_invocation', 'property_access']),
  extractSourceDeclaration: () => undefined,
  sinkNodeTypes: new Set(['method_invocation']),
  extractSinkCall: csharpTaintSink,
  sanitizerNodeTypes: new Set([]),
  extractSanitizerCall: csharpTaintSanitizer,
};

// ── C / C++ taint patterns ──────────────────────────────────────────────────

const C_SINK_FUNCTIONS = new Set([
  'system',
  'popen',
  'execv',
  'execve',
  'execvp',
  'execl',
  'execlp',
  'scanf',
  'sscanf',
  'fscanf',
  'gets',
  'strcpy',
  'strcat',
  'sprintf',
  'malloc',
  'calloc',
  'realloc', // memory alloc — not a sink per se but security relevant
]);

function cTaintSource(node: SyntaxNode): TaintPattern | undefined {
  // C: scanf (reads from stdin), gets (removed but legacy), fgets with stdin
  const name = node.childForFieldName('function');
  if (!name) return undefined;
  const fnName = name.text;
  if (['scanf', 'fscanf', 'gets', 'fgets', 'getenv'].includes(fnName)) {
    return { name: `c-source:${fnName}`, description: `Input function: ${fnName}()` };
  }
  return undefined;
}

function cTaintSink(node: SyntaxNode): TaintPattern | undefined {
  const name = node.childForFieldName('function');
  if (!name) return undefined;
  const fnName = name.text;
  if (C_SINK_FUNCTIONS.has(fnName)) {
    return { name: `c-sink:${fnName}`, description: `Dangerous function: ${fnName}()` };
  }
  return undefined;
}

function cTaintSanitizer(_node: SyntaxNode): TaintPattern | undefined {
  return undefined;
}

export const cTaintConfig: TaintConfig = {
  sourceNodeTypes: new Set(['call_expression']),
  extractSourceDeclaration: () => undefined,
  sinkNodeTypes: new Set(['call_expression']),
  extractSinkCall: cTaintSink,
  sanitizerNodeTypes: new Set([]),
  extractSanitizerCall: cTaintSanitizer,
};

// ── Rust taint patterns ─────────────────────────────────────────────────────

const RUST_SINK_FUNCTIONS = new Set(['exec', 'eval', 'for_name']);

function rustTaintSource(node: SyntaxNode): TaintPattern | undefined {
  // Rust: env!("..."), std::env::var("..."), std::io::stdin()
  const path = node.childForFieldName('function');
  if (!path) return undefined;
  const fnName = path.text;
  if (['var', 'var_os'].includes(fnName)) {
    return { name: 'rust-env', description: 'Environment variable via std::env::var()' };
  }
  return undefined;
}

function rustTaintSink(node: SyntaxNode): TaintPattern | undefined {
  const path = node.childForFieldName('function');
  if (!path) return undefined;
  const fnName = path.text;
  if (RUST_SINK_FUNCTIONS.has(fnName)) {
    return { name: `rust-sink:${fnName}`, description: `Dangerous function: ${fnName}()` };
  }
  // serde_json::from_str — deserializing untrusted data
  if (fnName === 'from_str' || fnName === 'from_reader') {
    return { name: 'rust-deserialize', description: `Deserializing untrusted data: ${fnName}()` };
  }
  return undefined;
}

function rustTaintSanitizer(_node: SyntaxNode): TaintPattern | undefined {
  return undefined;
}

export const rustTaintConfig: TaintConfig = {
  sourceNodeTypes: new Set(['call_expression', 'macro_invocation']),
  extractSourceDeclaration: () => undefined,
  sinkNodeTypes: new Set(['call_expression']),
  extractSinkCall: rustTaintSink,
  sanitizerNodeTypes: new Set([]),
  extractSanitizerCall: rustTaintSanitizer,
};

// ── Swift taint patterns ───────────────────────────────────────────────────

const SWIFT_SINK_METHODS = new Set([
  'execute',
  'run',
  'eval',
  'forName',
  'withUnsafePointer',
  'withUnsafeBytes',
]);

function swiftTaintSource(node: SyntaxNode): TaintPattern | undefined {
  // Swift: ProcessInfo.processInfo.environment, UserDefaults, CommandLine.arguments
  const sel = node.childForFieldName('argument');
  if (!sel) return undefined;
  const fnName = sel.text;
  if (fnName === 'environment' || fnName === 'arguments') {
    return { name: 'swift-source', description: `System input: ${fnName}` };
  }
  return undefined;
}

function swiftTaintSink(node: SyntaxNode): TaintPattern | undefined {
  const sel = node.childForFieldName('argument');
  if (!sel) return undefined;
  const fnName = sel.text;
  if (SWIFT_SINK_METHODS.has(fnName)) {
    return { name: `swift-sink:${fnName}`, description: `Dangerous method: ${fnName}()` };
  }
  return undefined;
}

function swiftTaintSanitizer(_node: SyntaxNode): TaintPattern | undefined {
  return undefined;
}

export const swiftTaintConfig: TaintConfig = {
  sourceNodeTypes: new Set(['call_expression']),
  extractSourceDeclaration: () => undefined,
  sinkNodeTypes: new Set(['call_expression']),
  extractSinkCall: swiftTaintSink,
  sanitizerNodeTypes: new Set([]),
  extractSanitizerCall: swiftTaintSanitizer,
};

// ── TypeScript / JavaScript taint patterns ──────────────────────────────────

const TS_SINK_FUNCTIONS = new Set([
  'eval',
  'Function',
  'exec',
  'spawn',
  'spawnSync',
  'execSync',
  'execFile',
  'execFileSync',
  'query',
  'execute',
  'forName',
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'write',
  'writeln',
]);

const TS_SANITIZER_FUNCTIONS = new Set([
  'escape',
  'sanitize',
  'encodeURI',
  'encodeURIComponent',
  'htmlEscape',
  'templateEscape',
]);

function tsTaintSource(node: SyntaxNode): TaintPattern | undefined {
  // TS: process.env, req.body, req.params, req.query, req.headers
  let objName: string | undefined;
  let propName: string | undefined;

  if (node.type === 'member_expression') {
    const obj = node.childForFieldName('object');
    const prop = node.childForFieldName('property');
    objName = obj?.type === 'identifier' ? obj.text : undefined;
    propName = prop?.type === 'identifier' ? prop.text : undefined;
  } else if (node.type === 'call_expression') {
    const callee = node.childForFieldName('callee');
    if (callee?.type === 'member_expression') {
      const obj = callee.childForFieldName('object');
      const prop = callee.childForFieldName('property');
      objName = obj?.type === 'identifier' ? obj.text : undefined;
      propName = prop?.type === 'identifier' ? prop.text : undefined;
    }
  }

  if (objName === 'process' && propName === 'env') {
    return { name: 'ts-env', description: 'Process environment variable (process.env)' };
  }
  if ((objName === 'req' || objName === 'request') && propName) {
    if (['body', 'params', 'query', 'headers', 'cookies'].includes(propName)) {
      return {
        name: `ts-request-input:${propName}`,
        description: `HTTP request input: req.${propName}`,
      };
    }
  }
  if (objName === 'window' || objName === 'document') {
    return { name: `ts-dom-source:${propName}`, description: `DOM input: ${objName}.${propName}` };
  }
  return undefined;
}

function tsTaintSink(node: SyntaxNode): TaintPattern | undefined {
  let fnName: string | undefined;

  if (node.type === 'call_expression') {
    const callee = node.childForFieldName('callee');
    if (callee?.type === 'member_expression') {
      const prop = callee.childForFieldName('property');
      fnName = prop?.type === 'identifier' ? prop.text : undefined;
    } else if (callee?.type === 'identifier') {
      fnName = callee.text;
    }
  }

  if (fnName && TS_SINK_FUNCTIONS.has(fnName)) {
    return { name: `ts-sink:${fnName}`, description: `Dangerous function: ${fnName}()` };
  }
  return undefined;
}

function tsTaintSanitizer(node: SyntaxNode): TaintPattern | undefined {
  let fnName: string | undefined;

  if (node.type === 'call_expression') {
    const callee = node.childForFieldName('callee');
    if (callee?.type === 'member_expression') {
      const prop = callee.childForFieldName('property');
      fnName = prop?.type === 'identifier' ? prop.text : undefined;
    } else if (callee?.type === 'identifier') {
      fnName = callee.text;
    }
  }

  if (fnName && TS_SANITIZER_FUNCTIONS.has(fnName)) {
    return { name: `ts-sanitizer:${fnName}`, description: `Sanitizer function: ${fnName}()` };
  }
  return undefined;
}

export const typescriptTaintConfig: TaintConfig = {
  sourceNodeTypes: new Set(['member_expression', 'call_expression']),
  extractSourceDeclaration: () => undefined,
  sinkNodeTypes: new Set(['call_expression', 'new_expression']),
  extractSinkCall: tsTaintSink,
  sanitizerNodeTypes: new Set(['call_expression']),
  extractSanitizerCall: tsTaintSanitizer,
};

// ── Objective-C taint patterns ─────────────────────────────────────────────

const OBJC_SINK_SELECTORS = new Set([
  'execCommand:',
  'evaluateJavaScript:',
  'performSelector:',
  'executeFetchRequest:',
  'executeStatement:',
  'openURL:',
  'canOpenURL:',
]);

function objcTaintSource(node: SyntaxNode): TaintPattern | undefined {
  // ObjC: [[NSProcessInfo processInfo] environment], [[NSUserDefaults standardUserDefaults] ...]
  const sel = node.childForFieldName('selector');
  if (!sel) return undefined;
  const selName = sel.text;
  if (selName === 'environment' || selName === 'arguments') {
    return { name: 'objc-system-source', description: `System input: ${selName}` };
  }
  return undefined;
}

function objcTaintSink(node: SyntaxNode): TaintPattern | undefined {
  const sel = node.childForFieldName('selector');
  if (!sel) return undefined;
  const selName = sel.text;
  if (OBJC_SINK_SELECTORS.has(selName)) {
    return { name: `objc-sink:${selName}`, description: `Dangerous selector: ${selName}` };
  }
  return undefined;
}

function objcTaintSanitizer(_node: SyntaxNode): TaintPattern | undefined {
  return undefined;
}

export const objcTaintConfig: TaintConfig = {
  sourceNodeTypes: new Set(['message_expression']),
  extractSourceDeclaration: () => undefined,
  sinkNodeTypes: new Set(['message_expression']),
  extractSinkCall: objcTaintSink,
  sanitizerNodeTypes: new Set([]),
  extractSanitizerCall: objcTaintSanitizer,
};

// ── PHP taint patterns ─────────────────────────────────────────────────────

const PHP_SINK_FUNCTIONS = new Set([
  'eval',
  'exec',
  'system',
  'passthru',
  'shell_exec',
  'popen',
  'proc_open',
  'mysql_query',
  'mysqli_query',
  'pg_query',
  'sqlite_query',
  'unserialize',
  'include',
  'include_once',
  'require',
  'require_once',
  'create_function',
  'assert',
]);

function phpTaintSource(node: SyntaxNode): TaintPattern | undefined {
  if (node.type !== 'variable_name') return undefined;
  const name = node.text;
  if (['GET', 'POST', 'REQUEST', 'COOKIE', 'FILES', 'ENV', 'SERVER'].includes(name)) {
    return { name: `php-superglobal:${name}`, description: `PHP superglobal: $_${name}` };
  }
  return undefined;
}

function phpTaintSink(node: SyntaxNode): TaintPattern | undefined {
  const callee = node.childForFieldName('function');
  if (!callee) return undefined;
  const fnName = callee.text;
  if (PHP_SINK_FUNCTIONS.has(fnName)) {
    return { name: `php-sink:${fnName}`, description: `Dangerous function: ${fnName}()` };
  }
  return undefined;
}

function phpTaintSanitizer(_node: SyntaxNode): TaintPattern | undefined {
  return undefined;
}

export const phpTaintConfig: TaintConfig = {
  sourceNodeTypes: new Set(['variable_name']),
  extractSourceDeclaration: () => undefined,
  sinkNodeTypes: new Set(['function_call_expression']),
  extractSinkCall: phpTaintSink,
  sanitizerNodeTypes: new Set([]),
  extractSanitizerCall: phpTaintSanitizer,
};

// ── Python taint patterns ─────────────────────────────────────────────────

// Python dangerous functions that are taint sinks
const PYTHON_SINK_FUNCTIONS = new Set([
  'eval',
  'exec',
  'compile',
  'getattr',
  'setattr',
  'delattr',
  '__import__',
  'open',
  'subprocess.run',
  'subprocess.Popen',
  'subprocess.call',
]);

function pythonTaintSource(node: SyntaxNode): TaintPattern | undefined {
  if (node.type !== 'identifier') return undefined;
  const name = node.text;
  if (name === 'argv' || name === 'environ') {
    return { name: `python-source:${name}`, description: `System input via ${name}` };
  }
  return undefined;
}

function pythonTaintSink(node: SyntaxNode): TaintPattern | undefined {
  const callee = node.childForFieldName('function');
  if (!callee) return undefined;
  const fnName = callee.text;
  if (PYTHON_SINK_FUNCTIONS.has(fnName)) {
    return { name: `python-sink:${fnName}`, description: `Dangerous function: ${fnName}()` };
  }
  return undefined;
}

function pythonTaintSanitizer(_node: SyntaxNode): TaintPattern | undefined {
  return undefined;
}

export const pythonTaintConfig: TaintConfig = {
  sourceNodeTypes: new Set(['identifier']),
  extractSourceDeclaration: () => undefined,
  sinkNodeTypes: new Set(['call']),
  extractSinkCall: pythonTaintSink,
  sanitizerNodeTypes: new Set([]),
  extractSanitizerCall: pythonTaintSanitizer,
};

// ── Ruby taint patterns ───────────────────────────────────────────────────

const RUBY_SINK_METHODS = new Set([
  'eval',
  'exec',
  'system',
  'spawn',
  'popen',
  'send',
  'public_send',
  '__send__',
  'instance_eval',
  'class_eval',
  'module_eval',
]);

function rubyTaintSource(node: SyntaxNode): TaintPattern | undefined {
  if (node.type !== 'identifier') return undefined;
  const name = node.text;
  if (name === 'ARGV' || name === 'ENV' || name === 'STDIN') {
    return { name: `ruby-source:${name}`, description: `System input: ${name}` };
  }
  return undefined;
}

function rubyTaintSink(node: SyntaxNode): TaintPattern | undefined {
  const sel = node.childForFieldName('method');
  if (!sel) return undefined;
  const methodName = sel.text;
  if (RUBY_SINK_METHODS.has(methodName)) {
    return { name: `ruby-sink:${methodName}`, description: `Dangerous method: ${methodName}()` };
  }
  return undefined;
}

function rubyTaintSanitizer(_node: SyntaxNode): TaintPattern | undefined {
  return undefined;
}

export const rubyTaintConfig: TaintConfig = {
  sourceNodeTypes: new Set(['identifier']),
  extractSourceDeclaration: () => undefined,
  sinkNodeTypes: new Set(['call']),
  extractSinkCall: rubyTaintSink,
  sanitizerNodeTypes: new Set([]),
  extractSanitizerCall: rubyTaintSanitizer,
};

// ── ArkTS / HarmonyOS taint patterns ────────────────────────────────────────
//
// Sources (HarmonyOS inter-app / user input boundaries):
//   router.getParams()          — URL route parameters passed between pages
//   featureAbility.getWant()    — inter-app intent with arbitrary user-supplied data
//   rpc.RemoteObject callbacks  — IPC from remote processes
//
// Sinks (HarmonyOS dangerous APIs):
//   rdb.executeSql()            — SQL injection via raw query
//   http.createHttp().request() — outbound HTTP with attacker-controlled URL
//   fileIo.open() / write()     — file-path / content injection
//   childProcess.spawn()        — OS command injection
//   webview.loadUrl()           — open-redirect / XSS
//
// Sanitizers:
//   encodeURI / encodeURIComponent (inherited from TS)
//   JSON.parse — validates structural format (weaker sanitizer)

const ARKTS_SINK_METHODS = new Set([
  // Database (SQL injection)
  'executeSql',
  'querySql',
  // File I/O (path injection)
  'open',
  'write',
  'writeSync',
  'read',
  'readSync',
  // Network (SSRF / open redirect)
  'request',
  'requestInStream',
  // Process execution (OS command injection)
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  // WebView (XSS / open-redirect)
  'loadUrl',
  'runJavaScript',
  // Generic eval
  'eval',
  'Function',
]);

const ARKTS_SANITIZER_METHODS = new Set([
  'encodeURI',
  'encodeURIComponent',
  'htmlEscape',
  'sanitize',
  'escape',
]);

function arktsTaintSource(node: SyntaxNode): TaintPattern | undefined {
  // ArkTS taint sources operate on member expressions and call expressions.
  // Pattern: router.getParams(), featureAbility.getWant(),
  //          rpc.RemoteObject receive callbacks, AppStorage.get()
  let objName: string | undefined;
  let propName: string | undefined;

  if (node.type === 'member_expression') {
    const obj = node.childForFieldName('object');
    const prop = node.childForFieldName('property');
    objName = obj?.type === 'identifier' ? obj.text : undefined;
    propName = prop?.type === 'identifier' ? prop.text : undefined;
  } else if (node.type === 'call_expression') {
    const callee = node.childForFieldName('callee') ?? node.childForFieldName('function');
    if (callee?.type === 'member_expression') {
      const obj = callee.childForFieldName('object');
      const prop = callee.childForFieldName('property');
      objName = obj?.type === 'identifier' ? obj.text : undefined;
      propName = prop?.type === 'identifier' ? prop.text : undefined;
    } else if (callee?.type === 'identifier') {
      propName = callee.text;
    }
  }

  // router.getParams() — page routing parameters (user-controlled)
  if (objName === 'router' && propName === 'getParams') {
    return {
      name: 'arkts-router-params',
      description: 'HarmonyOS router.getParams() — user-controlled route parameters',
    };
  }
  // featureAbility.getWant() — inter-app intent
  if (objName === 'featureAbility' && propName === 'getWant') {
    return {
      name: 'arkts-want',
      description: 'HarmonyOS featureAbility.getWant() — inter-app intent data',
    };
  }
  // AppStorage.get() / LocalStorage.get() — persistent state that may originate externally
  if ((objName === 'AppStorage' || objName === 'LocalStorage') && propName === 'get') {
    return {
      name: 'arkts-storage-get',
      description: `HarmonyOS ${objName}.get() — externally-persisted value`,
    };
  }
  // promptAction.showDialog result / TextInput event handlers treated as DOM-like sources
  if (objName === 'promptAction' && propName === 'showDialog') {
    return {
      name: 'arkts-dialog-input',
      description: 'HarmonyOS promptAction.showDialog() — user dialog input',
    };
  }
  return undefined;
}

function arktsTaintSink(node: SyntaxNode): TaintPattern | undefined {
  let fnName: string | undefined;

  if (node.type === 'call_expression') {
    const callee = node.childForFieldName('callee') ?? node.childForFieldName('function');
    if (callee?.type === 'member_expression') {
      const prop = callee.childForFieldName('property');
      fnName = prop?.type === 'identifier' ? prop.text : undefined;
    } else if (callee?.type === 'identifier') {
      fnName = callee.text;
    }
  }

  if (fnName && ARKTS_SINK_METHODS.has(fnName)) {
    return { name: `arkts-sink:${fnName}`, description: `HarmonyOS dangerous API: ${fnName}()` };
  }
  return undefined;
}

function arktsTaintSanitizer(node: SyntaxNode): TaintPattern | undefined {
  let fnName: string | undefined;

  if (node.type === 'call_expression') {
    const callee = node.childForFieldName('callee') ?? node.childForFieldName('function');
    if (callee?.type === 'member_expression') {
      const prop = callee.childForFieldName('property');
      fnName = prop?.type === 'identifier' ? prop.text : undefined;
    } else if (callee?.type === 'identifier') {
      fnName = callee.text;
    }
  }

  if (fnName && ARKTS_SANITIZER_METHODS.has(fnName)) {
    return { name: `arkts-sanitizer:${fnName}`, description: `ArkTS sanitizer: ${fnName}()` };
  }
  return undefined;
}

export const arktsTaintConfig: TaintConfig = {
  sourceNodeTypes: new Set(['member_expression', 'call_expression']),
  extractSourceDeclaration: () => undefined,
  sinkNodeTypes: new Set(['call_expression']),
  extractSinkCall: arktsTaintSink,
  sanitizerNodeTypes: new Set(['call_expression']),
  extractSanitizerCall: arktsTaintSanitizer,
};

// ── Taint Config Registry ───────────────────────────────────────────────────

/**
 * Registry of taint configurations for all supported languages.
 * Used by the dataflow analysis engine to perform taint tracking.
 */
export const TAINT_CONFIGS: Record<string, TaintConfig> = {
  java: javaTaintConfig,
  kotlin: kotlinTaintConfig,
  go: goTaintConfig,
  dart: dartTaintConfig,
  csharp: csharpTaintConfig,
  c: cTaintConfig,
  cpp: cTaintConfig,
  rust: rustTaintConfig,
  swift: swiftTaintConfig,
  typescript: typescriptTaintConfig,
  javascript: typescriptTaintConfig,
  arkts: arktsTaintConfig,
  php: phpTaintConfig,
  python: pythonTaintConfig,
  ruby: rubyTaintConfig,
  objectivec: objcTaintConfig,
};
