# GitNexus 大型 Diff 安全降级实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `detect_changes` 工具在超大 diff 场景下的优雅降级，避免 ENOBUFS 错误，返回有价值的文件/符号信息。

**Architecture:** 三层降级策略（行级 → 符号级 → 文件级），使用 FilePathIndex 加速符号查询，多层兜底方案（git diff → git diff --name-status → git log）。

**Tech Stack:** TypeScript, Node.js child_process (execFile), Git CLI

---

## Task 1: 添加降级常量和类型定义

**Files:**
- Modify: `src/mcp/local/tools/shared.ts`

- [ ] **Step 1: 添加常量定义**

在 `src/mcp/local/tools/shared.ts` 文件末尾添加：

```typescript
// ─────────────────────────────────────────────────────────────
// Diff Degradation Support
// ─────────────────────────────────────────────────────────────

/** Diff 大小阈值 */
export const DIFF_SIZE_THRESHOLDS = {
  /** 正常模式最大值 - 行级精度 */
  NORMAL_MAX: 512 * 1024,  // 512KB
  
  /** 降级模式最大值 - 符号级精度 */
  SYMBOL_LEVEL_MAX: 2 * 1024 * 1024,  // 2MB
  
  /** 滞后系数 - 防止边界抖动 */
  HYSTERESIS: 0.95,
} as const;

/** 精度级别 */
export type DetectPrecision = 'normal' | 'symbol-level' | 'file-level';

/** 降级原因 */
export type DegradedReason = 
  | 'diff_exceeded_512kb' 
  | 'diff_exceeded_2mb'
  | 'file_count_exceeded';

/** 可配置阈值 */
export interface DegradationConfig {
  normalMaxBytes?: number;
  symbolLevelMaxBytes?: number;
  enableSymbolLevel?: boolean;
}

/**
 * 根据diff大小确定精度级别
 */
export function determinePrecision(
  diffSize: number,
  config?: DegradationConfig,
): DetectPrecision {
  const normalMax = config?.normalMaxBytes ?? DIFF_SIZE_THRESHOLDS.NORMAL_MAX;
  const symbolMax = config?.symbolLevelMaxBytes ?? DIFF_SIZE_THRESHOLDS.SYMBOL_LEVEL_MAX;
  
  // 应用滞后系数防止边界抖动
  const effectiveNormalMax = normalMax * DIFF_SIZE_THRESHOLDS.HYSTERESIS;
  const effectiveSymbolMax = symbolMax * DIFF_SIZE_THRESHOLDS.HYSTERESIS;
  
  if (diffSize <= effectiveNormalMax) {
    return 'normal';
  }
  
  if (diffSize <= effectiveSymbolMax) {
    return 'symbol-level';
  }
  
  return 'file-level';
}

/**
 * 格式化字节数为人类可读格式
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  
  return `${size.toFixed(2)} ${units[i]}`;
}
```

- [ ] **Step 2: 验证类型导出**

运行类型检查：
```bash
npx tsc --noEmit
```

Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/mcp/local/tools/shared.ts
git commit -m "feat(degradation): add constants and types for diff degradation"
```

---

## Task 2: 添加 FilePathIndex 类

**Files:**
- Modify: `src/mcp/local/local-backend.ts`

- [ ] **Step 1: 添加导入和 FilePathIndex 类**

在 `src/mcp/local/local-backend.ts` 文件顶部添加类型导入：

```typescript
import type { GraphNode } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../core/graph/types.js';
```

在 `LocalBackend` 类定义之前添加 `FilePathIndex` 类：

```typescript
/**
 * 文件路径到符号的索引，加速符号查询
 * 
 * 用于降级模式下快速查找文件内的所有符号，
 * 避免遍历整个知识图谱。
 */
export class FilePathIndex {
  private index: Map<string, GraphNode[]> = new Map();
  private built = false;
  
  /**
   * 从知识图谱构建索引
   */
  build(graph: KnowledgeGraph): void {
    if (this.built) return;
    
    for (const node of graph.iterNodes()) {
      const filePath = node.properties.filePath;
      if (!filePath) continue;
      
      if (!this.index.has(filePath)) {
        this.index.set(filePath, []);
      }
      this.index.get(filePath)!.push(node);
    }
    
    // 按行号排序
    for (const [path, symbols] of this.index) {
      symbols.sort((a, b) => 
        (a.properties.line || 0) - (b.properties.line || 0)
      );
    }
    
    this.built = true;
  }
  
  /**
   * 查找文件内的所有符号
   * O(1) 查找，不再需要遍历全图
   */
  findSymbolsInFile(filePath: string): GraphNode[] {
    return this.index.get(filePath) || [];
  }
  
  /**
   * 获取索引统计信息
   */
  getStats(): { files: number; symbols: number } {
    let symbols = 0;
    for (const syms of this.index.values()) {
      symbols += syms.length;
    }
    return { files: this.index.size, symbols };
  }
  
  /**
   * 清除索引
   */
  clear(): void {
    this.index.clear();
    this.built = false;
  }
}
```

- [ ] **Step 2: 在 LocalBackend 类中添加 filePathIndex 属性**

在 `LocalBackend` 类中添加：

```typescript
/** 文件路径索引，用于降级模式快速符号查询 */
private filePathIndex: FilePathIndex | null = null;

/**
 * 获取文件路径索引（延迟构建）
 */
getFilePathIndex(): FilePathIndex {
  if (!this.filePathIndex) {
    this.filePathIndex = new FilePathIndex();
    if (this.graph) {
      this.filePathIndex.build(this.graph);
    }
  }
  return this.filePathIndex;
}
```

- [ ] **Step 3: 在 init() 方法中重置索引**

在 `init()` 方法中，找到 `this.graph = graph;` 之后添加：

```typescript
// 重置文件路径索引
if (this.filePathIndex) {
  this.filePathIndex.clear();
}
```

- [ ] **Step 4: 验证类型检查**

```bash
npx tsc --noEmit
```

Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add src/mcp/local/local-backend.ts
git commit -m "feat(degradation): add FilePathIndex for O(1) symbol lookup"
```

---

## Task 3: 添加 Git Diff 解析器降级支持

**Files:**
- Modify: `src/mcp/local/tools/git-diff-parser.ts`

- [ ] **Step 1: 添加导入和类型定义**

在文件顶部添加：

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  determinePrecision,
  formatBytes,
  type DetectPrecision,
  type DegradedReason,
  type DegradationConfig,
} from './shared.js';

const execFileAsync = promisify(execFile);
```

添加类型定义：

```typescript
/** Diff 解析结果 */
export interface DiffParseResult {
  success: boolean;
  precision: DetectPrecision;
  reason?: DegradedReason;
  diffSize: number;
  files: FileChangeInfo[];
  error?: string;
}

/** 文件变更信息 */
export interface FileChangeInfo {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;  // for renamed files
  hunks?: DiffHunk[];  // only in normal precision
}

/** Diff 解析选项 */
export interface DiffParseOptions {
  repoPath: string;
  scope: 'unstaged' | 'staged' | 'all' | 'compare';
  baseRef?: string;
  config?: DegradationConfig;
  fileFilter?: string;  // 单文件模式
}
```

- [ ] **Step 2: 添加主解析函数**

```typescript
/**
 * 带降级支持的 diff 解析
 * 
 * 根据输出大小自动选择精度级别：
 * - normal: 行级精度
 * - symbol-level: 符号级精度
 * - file-level: 文件级精度
 */
export async function parseDiffWithDegradation(
  options: DiffParseOptions,
): Promise<DiffParseResult> {
  const { repoPath, scope, baseRef, config, fileFilter } = options;
  
  try {
    // 尝试获取完整 diff
    const diffArgs = buildDiffArgs(scope, baseRef, fileFilter);
    const { stdout, stderr } = await execFileAsync('git', diffArgs, {
      cwd: repoPath,
      maxBuffer: 50 * 1024 * 1024,  // 50MB buffer
      encoding: 'utf8',
    });
    
    const diffSize = Buffer.byteLength(stdout, 'utf8');
    const precision = determinePrecision(diffSize, config);
    
    if (precision === 'normal') {
      // 正常模式：解析完整 diff
      const files = parseDiffOutput(stdout);
      return {
        success: true,
        precision: 'normal',
        diffSize,
        files,
      };
    }
    
    if (precision === 'symbol-level') {
      // 符号级降级：只返回文件列表，不解析行变更
      const files = parseDiffOutputHeaderOnly(stdout);
      return {
        success: true,
        precision: 'symbol-level',
        reason: 'diff_exceeded_512kb',
        diffSize,
        files,
      };
    }
    
    // 文件级降级：使用 --name-status
    return await getFileListFromGit(repoPath, scope, baseRef, fileFilter, diffSize);
    
  } catch (err: unknown) {
    // 处理 ENOBUFS 或其他错误
    if (isEnobufsError(err)) {
      return handleEnobufsError(repoPath, scope, baseRef, fileFilter);
    }
    
    return {
      success: false,
      precision: 'file-level',
      diffSize: 0,
      files: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 构建 git diff 参数
 */
function buildDiffArgs(
  scope: 'unstaged' | 'staged' | 'all' | 'compare',
  baseRef?: string,
  fileFilter?: string,
): string[] {
  const args: string[] = ['diff'];
  
  switch (scope) {
    case 'unstaged':
      // 默认就是 unstaged
      break;
    case 'staged':
      args.push('--cached');
      break;
    case 'all':
      args.push('HEAD');
      break;
    case 'compare':
      if (baseRef) {
        args.push(baseRef, 'HEAD');
      } else {
        args.push('main', 'HEAD');
      }
      break;
  }
  
  if (fileFilter) {
    args.push('--', fileFilter);
  }
  
  return args;
}

/**
 * 检查是否为 ENOBUFS 错误
 */
function isEnobufsError(err: unknown): boolean {
  if (err instanceof Error) {
    const nodeErr = err as NodeJS.ErrnoException;
    return nodeErr.code === 'ENOBUFS' || 
           err.message.includes('ENOBUFS') ||
           err.message.includes('maxBuffer');
  }
  return false;
}

/**
 * 处理 ENOBUFS 错误
 */
async function handleEnobufsError(
  repoPath: string,
  scope: 'unstaged' | 'staged' | 'all' | 'compare',
  baseRef?: string,
  fileFilter?: string,
): Promise<DiffParseResult> {
  // 尝试使用 --name-status 获取文件列表
  try {
    const result = await getFileListFromGit(repoPath, scope, baseRef, fileFilter, 0);
    return {
      ...result,
      reason: 'diff_exceeded_2mb',
    };
  } catch {
    // 最后兜底：使用 git log
    return getFileListFromGitLog(repoPath, scope, baseRef, fileFilter);
  }
}

/**
 * 只解析 diff 头部（文件路径和状态）
 */
function parseDiffOutputHeaderOnly(diffOutput: string): FileChangeInfo[] {
  const files: FileChangeInfo[] = [];
  const lines = diffOutput.split('\n');
  
  for (const line of lines) {
    // 匹配 diff --git a/path b/path 格式
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match) {
      const [, oldPath, newPath] = match;
      
      // 查找状态标记
      let status: 'added' | 'modified' | 'deleted' | 'renamed' = 'modified';
      const nextLineIdx = lines.indexOf(line) + 1;
      if (nextLineIdx < lines.length) {
        const nextLine = lines[nextLineIdx];
        if (nextLine.startsWith('new file')) {
          status = 'added';
        } else if (nextLine.startsWith('deleted')) {
          status = 'deleted';
        } else if (nextLine.startsWith('rename from')) {
          status = 'renamed';
        }
      }
      
      files.push({
        path: newPath,
        status,
        oldPath: oldPath !== newPath ? oldPath : undefined,
      });
    }
  }
  
  return files;
}

/**
 * 使用 git diff --name-status 获取文件列表
 */
async function getFileListFromGit(
  repoPath: string,
  scope: 'unstaged' | 'staged' | 'all' | 'compare',
  baseRef?: string,
  fileFilter?: string,
  diffSize: number = 0,
): Promise<DiffParseResult> {
  const args = ['diff', '--name-status', ...buildDiffArgs(scope, baseRef, fileFilter).slice(1)];
  
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
  });
  
  const files: FileChangeInfo[] = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [statusChar, ...pathParts] = line.split('\t');
      const path = pathParts.join('\t');  // 处理路径中可能有 tab 的情况
      
      let status: 'added' | 'modified' | 'deleted' | 'renamed';
      let oldPath: string | undefined;
      
      switch (statusChar) {
        case 'A':
          status = 'added';
          break;
        case 'D':
          status = 'deleted';
          break;
        case 'R':
          status = 'renamed';
          oldPath = pathParts[0];
          break;
        default:
          status = 'modified';
      }
      
      return { path, status, oldPath };
    });
  
  return {
    success: true,
    precision: 'file-level',
    reason: 'diff_exceeded_2mb',
    diffSize,
    files,
  };
}

/**
 * 使用 git log 获取文件列表（最后兜底）
 */
async function getFileListFromGitLog(
  repoPath: string,
  scope: 'unstaged' | 'staged' | 'all' | 'compare',
  baseRef?: string,
  fileFilter?: string,
): Promise<DiffParseResult> {
  let args: string[];
  
  if (scope === 'compare' && baseRef) {
    args = ['log', '--name-status', '--pretty=format:', `${baseRef}..HEAD`];
  } else if (scope === 'staged') {
    args = ['diff', '--cached', '--name-status'];
  } else {
    args = ['diff', '--name-status'];
  }
  
  if (fileFilter) {
    args.push('--', fileFilter);
  }
  
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
  });
  
  // 去重文件列表
  const fileMap = new Map<string, FileChangeInfo>();
  const lines = stdout.trim().split('\n').filter(Boolean);
  
  for (const line of lines) {
    const [statusChar, ...pathParts] = line.split('\t');
    const path = pathParts[pathParts.length - 1];  // 对于 rename，取新路径
    
    if (!fileMap.has(path)) {
      let status: 'added' | 'modified' | 'deleted' | 'renamed' = 'modified';
      switch (statusChar) {
        case 'A': status = 'added'; break;
        case 'D': status = 'deleted'; break;
        case 'R': status = 'renamed'; break;
      }
      fileMap.set(path, { path, status });
    }
  }
  
  return {
    success: true,
    precision: 'file-level',
    reason: 'diff_exceeded_2mb',
    diffSize: 0,
    files: Array.from(fileMap.values()),
  };
}
```

- [ ] **Step 3: 验证类型检查**

```bash
npx tsc --noEmit
```

Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/mcp/local/tools/git-diff-parser.ts
git commit -m "feat(degradation): add parseDiffWithDegradation with multi-tier fallback"
```

---

## Task 4: 更新 detect_changes 工具支持降级

**Files:**
- Modify: `src/mcp/local/tools/detect.ts`

- [ ] **Step 1: 添加导入**

在文件顶部添加：

```typescript
import {
  determinePrecision,
  formatBytes,
  type DetectPrecision,
  type DegradedReason,
  type DegradationConfig,
} from './shared.js';
import {
  parseDiffWithDegradation,
  type DiffParseResult,
  type FileChangeInfo,
} from './git-diff-parser.js';
import type { LocalBackend } from '../local-backend.js';
```

- [ ] **Step 2: 添加降级响应构建函数**

```typescript
/**
 * 构建降级响应
 */
function buildDegradedResponse(
  result: DiffParseResult,
  backend: LocalBackend,
  config?: DegradationConfig,
): DegradedDetectResult {
  const filePathIndex = backend.getFilePathIndex();
  
  const filesWithSymbols = result.files.map(file => {
    const symbols = result.precision !== 'file-level'
      ? filePathIndex.findSymbolsInFile(file.path).map(node => ({
          name: node.properties.name || '',
          uid: node.properties.uid || '',
          type: node.labels[0] as 'Function' | 'Method' | 'Class' | 'Variable',
          line_start: node.properties.line || 0,
          line_end: node.properties.endLine || node.properties.line || 0,
        }))
      : undefined;
    
    // 构建 drill-down 命令
    const drillDown = symbols && symbols.length > 0
      ? {
          command: `gitnexus impact ${symbols[0].name} --uid ${symbols[0].uid} --direction upstream`,
          description: `Analyze impact of ${symbols[0].name} (exact match by UID)`,
        }
      : undefined;
    
    return {
      path: file.path,
      status: file.status,
      symbols,
      drill_down: drillDown,
    };
  });
  
  // 统计信息
  const stats = {
    total_files: result.files.length,
    total_symbols: filesWithSymbols.reduce((sum, f) => sum + (f.symbols?.length || 0), 0),
    diff_size_bytes: result.diffSize,
    diff_size_human: formatBytes(result.diffSize),
  };
  
  // 用户建议
  const suggestion = result.precision === 'symbol-level'
    ? `Diff too large for line-level analysis (${stats.diff_size_human}). Showing all symbols in changed files. Use drill-down commands for specific symbol impact analysis.`
    : `Diff too large for symbol-level analysis (${stats.diff_size_human}). Showing file list only. Use --file option to analyze specific files.`;
  
  // 替代命令
  const alternativeCommands = result.precision === 'symbol-level'
    ? [
        'gitnexus detect-changes --file <path>  # Analyze specific file',
        'gitnexus impact <symbol> --uid <uid>   # Analyze specific symbol',
      ]
    : [
        'gitnexus detect-changes --file <path>  # Analyze specific file',
        'gitnexus context <symbol>              # Get symbol context',
      ];
  
  // 向后兼容字段
  const changedFiles = result.files.map(f => f.path);
  const affectedSymbols = filesWithSymbols
    .flatMap(f => (f.symbols || []).map(s => ({ name: s.name, uid: s.uid, file: f.path })));
  
  return {
    truncated: true,
    precision: result.precision,
    reason: result.reason,
    original_diff_size: result.diffSize,
    stats,
    files: filesWithSymbols,
    suggestion,
    alternative_commands: alternativeCommands,
    changed_files: changedFiles,
    affected_symbols: affectedSymbols,
    execution_flows: [],
  };
}

interface DegradedDetectResult {
  truncated: true;
  precision: DetectPrecision;
  reason?: DegradedReason;
  original_diff_size: number;
  stats: {
    total_files: number;
    total_symbols: number;
    diff_size_bytes: number;
    diff_size_human: string;
  };
  files: Array<{
    path: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
    symbols?: Array<{
      name: string;
      uid: string;
      type: 'Function' | 'Method' | 'Class' | 'Variable';
      line_start: number;
      line_end: number;
    }>;
    drill_down?: {
      command: string;
      description: string;
    };
  }>;
  suggestion: string;
  alternative_commands: string[];
  changed_files: string[];
  affected_symbols: Array<{ name: string; uid: string; file: string }>;
  execution_flows: [];
}
```

- [ ] **Step 3: 修改 detectChangesTool 函数**

找到 `detectChangesTool` 函数，修改其实现以支持降级：

```typescript
export async function detectChangesTool(
  backend: LocalBackend,
  args: DetectChangesArgs,
): Promise<DetectChangesResult | DegradedDetectResult> {
  const {
    scope = 'unstaged',
    base_ref: baseRef,
    repo: repoName,
    enable_detection: enableDetection = false,
    file_filter: fileFilter,
    force_precision: forcePrecision,
    threshold_override: thresholdOverride,
  } = args;
  
  const repo = backend.getRepo(repoName);
  if (!repo) {
    return {
      error: repoName 
        ? `Repository not found: ${repoName}` 
        : 'No repository specified and no default available',
    };
  }
  
  const config: DegradationConfig | undefined = thresholdOverride
    ? {
        normalMaxBytes: thresholdOverride.normal_max,
        symbolLevelMaxBytes: thresholdOverride.symbol_max,
      }
    : undefined;
  
  // 使用新的降级解析器
  const diffResult = await parseDiffWithDegradation({
    repoPath: repo.path,
    scope,
    baseRef,
    config,
    fileFilter,
  });
  
  if (!diffResult.success) {
    return {
      error: diffResult.error || 'Failed to parse git diff',
    };
  }
  
  // 如果是降级模式，返回降级响应
  if (diffResult.precision !== 'normal' || forcePrecision) {
    const precision = forcePrecision || diffResult.precision;
    if (precision !== 'normal') {
      return buildDegradedResponse(
        { ...diffResult, precision },
        backend,
        config,
      );
    }
  }
  
  // 正常模式：继续原有的分析逻辑
  // ... 保持原有的 detectChangesTool 实现逻辑 ...
}
```

- [ ] **Step 4: 更新类型定义**

在 `DetectChangesArgs` 接口中添加新参数：

```typescript
export interface DetectChangesArgs {
  scope?: 'unstaged' | 'staged' | 'all' | 'compare';
  base_ref?: string;
  repo?: string;
  enable_detection?: boolean;
  // 新增参数
  file_filter?: string;
  force_precision?: 'normal' | 'symbol-level' | 'file-level';
  threshold_override?: {
    normal_max?: number;
    symbol_max?: number;
  };
}
```

- [ ] **Step 5: 验证类型检查**

```bash
npx tsc --noEmit
```

Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add src/mcp/local/tools/detect.ts
git commit -m "feat(degradation): update detect_changes tool for degradation support"
```

---

## Task 5: 添加 CLI 选项支持降级控制

**Files:**
- Modify: `src/cli/index.ts`
- Modify: `src/cli/tool.ts`

- [ ] **Step 1: 更新 CLI 定义 (index.ts)**

找到 `detect-changes` 命令定义，添加新选项：

```typescript
program
  .command('detect-changes')
  .description('Detect execution flows affected by git changes (pre-commit review)')
  .option('-s, --scope <scope>', 'What to analyze: "unstaged" (default), "staged", "all", or "compare"', 'unstaged')
  .option('--base-ref <ref>', 'For "compare" scope: base branch to compare against (default: main)')
  .option('-r, --repo <name>', 'Target repository (omit if only one indexed)')
  .option('--detection', 'Enable bug detection rules on changed symbols (off by default)')
  // 新增选项
  .option('-f, --file <path>', 'Analyze a specific file only (drill-down mode)')
  .option('--precision <level>', 'Force precision level: normal, symbol-level, or file-level')
  .option('--normal-max <bytes>', 'Override normal mode threshold (default: 524288)')
  .option('--symbol-max <bytes>', 'Override symbol-level threshold (default: 2097152)')
  .action(createLazyAction(() => import('./tool.js'), 'detectChangesCommand'));
```

- [ ] **Step 2: 更新 CLI 实现 (tool.ts)**

修改 `detectChangesCommand` 函数：

```typescript
export async function detectChangesCommand(
  options?: {
    scope?: string;
    baseRef?: string;
    repo?: string;
    detection?: boolean;
    // 新增选项
    file?: string;
    precision?: string;
    normalMax?: string;
    symbolMax?: string;
  },
): Promise<void> {
  const backend = await getBackend();
  
  // 解析阈值覆盖
  let thresholdOverride: { normal_max?: number; symbol_max?: number } | undefined;
  if (options?.normalMax || options?.symbolMax) {
    thresholdOverride = {
      normal_max: options.normalMax ? parseInt(options.normalMax, 10) : undefined,
      symbol_max: options.symbolMax ? parseInt(options.symbolMax, 10) : undefined,
    };
  }
  
  const result = await backend.callTool('detect_changes', {
    scope: options?.scope || 'unstaged',
    base_ref: options?.baseRef,
    repo: options?.repo,
    enable_detection: options?.detection ?? false,
    file_filter: options?.file,
    force_precision: options?.precision as 'normal' | 'symbol-level' | 'file-level' | undefined,
    threshold_override: thresholdOverride,
  });
  output(result);
}
```

- [ ] **Step 3: 验证类型检查**

```bash
npx tsc --noEmit
```

Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/cli/index.ts src/cli/tool.ts
git commit -m "feat(degradation): add CLI options for degradation control"
```

---

## Task 6: 添加配置文件支持

**Files:**
- Create: `src/core/config/degradation-config.ts`

- [ ] **Step 1: 创建配置加载模块**

```typescript
// src/core/config/degradation-config.ts

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { DegradationConfig } from '../../mcp/local/tools/shared.js';

/** 配置文件接口 */
interface DegradationConfigFile extends DegradationConfig {
  /** 是否启用符号级降级 */
  enableSymbolLevel?: boolean;
  /** 文件数量阈值（可选） */
  fileCountThreshold?: number;
}

/** 默认配置 */
const DEFAULT_CONFIG: Required<DegradationConfigFile> = {
  normalMaxBytes: 512 * 1024,      // 512KB
  symbolLevelMaxBytes: 2 * 1024 * 1024,  // 2MB
  enableSymbolLevel: true,
  fileCountThreshold: 100,
};

/**
 * 从环境变量加载配置
 */
function loadFromEnv(): Partial<DegradationConfigFile> {
  const config: Partial<DegradationConfigFile> = {};
  
  const normalMax = process.env.GITNEXUS_DIFF_NORMAL_MAX;
  if (normalMax) {
    config.normalMaxBytes = parseInt(normalMax, 10);
  }
  
  const symbolMax = process.env.GITNEXUS_DIFF_SYMBOL_MAX;
  if (symbolMax) {
    config.symbolLevelMaxBytes = parseInt(symbolMax, 10);
  }
  
  const enableSymbol = process.env.GITNEXUS_DIFF_ENABLE_SYMBOL;
  if (enableSymbol !== undefined) {
    config.enableSymbolLevel = enableSymbol === 'true' || enableSymbol === '1';
  }
  
  return config;
}

/**
 * 从文件加载配置
 */
async function loadFromFile(repoPath: string): Promise<Partial<DegradationConfigFile>> {
  const configPath = join(repoPath, '.gitnexus', 'degradation.json');
  
  if (!existsSync(configPath)) {
    return {};
  }
  
  try {
    const content = await readFile(configPath, 'utf8');
    return JSON.parse(content) as Partial<DegradationConfigFile>;
  } catch (err) {
    console.warn(`Failed to load degradation config: ${err}`);
    return {};
  }
}

/**
 * 加载降级配置（合并环境变量和文件配置）
 * 
 * 优先级：环境变量 > 配置文件 > 默认值
 */
export async function loadDegradationConfig(
  repoPath?: string,
): Promise<Required<DegradationConfigFile>> {
  const envConfig = loadFromEnv();
  const fileConfig = repoPath ? await loadFromFile(repoPath) : {};
  
  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...envConfig,
  };
}

/**
 * 验证配置有效性
 */
export function validateConfig(config: DegradationConfigFile): boolean {
  if (config.normalMaxBytes !== undefined && config.normalMaxBytes <= 0) {
    return false;
  }
  if (config.symbolLevelMaxBytes !== undefined && config.symbolLevelMaxBytes <= 0) {
    return false;
  }
  if (
    config.normalMaxBytes !== undefined &&
    config.symbolLevelMaxBytes !== undefined &&
    config.normalMaxBytes >= config.symbolLevelMaxBytes
  ) {
    return false;
  }
  return true;
}
```

- [ ] **Step 2: 创建配置文件示例**

创建 `docs/examples/degradation.json`:

```json
{
  "normalMaxBytes": 524288,
  "symbolLevelMaxBytes": 2097152,
  "enableSymbolLevel": true,
  "fileCountThreshold": 100
}
```

- [ ] **Step 3: 验证类型检查**

```bash
npx tsc --noEmit
```

Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/core/config/degradation-config.ts docs/examples/degradation.json
git commit -m "feat(degradation): add configuration file support"
```

---

## Task 7: 添加单元测试

**Files:**
- Create: `tests/unit/diff-degradation.test.ts`

- [ ] **Step 1: 创建测试文件**

```typescript
// tests/unit/diff-degradation.test.ts

import { describe, it, expect } from 'vitest';
import {
  determinePrecision,
  formatBytes,
  DIFF_SIZE_THRESHOLDS,
  type DegradationConfig,
} from '../../src/mcp/local/tools/shared.js';

describe('Diff Degradation', () => {
  describe('determinePrecision', () => {
    it('should return normal for small diffs', () => {
      const smallDiff = 100 * 1024; // 100KB
      expect(determinePrecision(smallDiff)).toBe('normal');
    });

    it('should return normal for diffs at threshold with hysteresis', () => {
      const thresholdDiff = DIFF_SIZE_THRESHOLDS.NORMAL_MAX * DIFF_SIZE_THRESHOLDS.HYSTERESIS;
      expect(determinePrecision(thresholdDiff)).toBe('normal');
    });

    it('should return symbol-level for medium diffs', () => {
      const mediumDiff = 1 * 1024 * 1024; // 1MB
      expect(determinePrecision(mediumDiff)).toBe('symbol-level');
    });

    it('should return file-level for large diffs', () => {
      const largeDiff = 3 * 1024 * 1024; // 3MB
      expect(determinePrecision(largeDiff)).toBe('file-level');
    });

    it('should respect custom config', () => {
      const diff = 600 * 1024; // 600KB
      const config: DegradationConfig = {
        normalMaxBytes: 1 * 1024 * 1024, // 1MB
      };
      expect(determinePrecision(diff, config)).toBe('normal');
    });

    it('should apply hysteresis to prevent oscillation', () => {
      const justOverThreshold = DIFF_SIZE_THRESHOLDS.NORMAL_MAX * 1.01;
      expect(determinePrecision(justOverThreshold)).toBe('symbol-level');
      
      const justUnderThreshold = DIFF_SIZE_THRESHOLDS.NORMAL_MAX * 0.99;
      expect(determinePrecision(justUnderThreshold)).toBe('normal');
    });
  });

  describe('formatBytes', () => {
    it('should format bytes correctly', () => {
      expect(formatBytes(0)).toBe('0 B');
      expect(formatBytes(512)).toBe('512.00 B');
      expect(formatBytes(1024)).toBe('1.00 KB');
      expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
      expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
    });

    it('should handle large numbers', () => {
      expect(formatBytes(19371)).toBe('18.92 KB');
      expect(formatBytes(512 * 1024)).toBe('512.00 KB');
    });
  });
});
```

- [ ] **Step 2: 添加 FilePathIndex 测试**

```typescript
// tests/unit/file-path-index.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import { FilePathIndex } from '../../src/mcp/local/local-backend.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import type { GraphNode } from 'gitnexus-shared';

// Mock graph for testing
function createMockGraph(nodes: GraphNode[]): KnowledgeGraph {
  return {
    iterNodes: () => nodes[Symbol.iterator](),
    getNode: (uid: string) => nodes.find(n => n.properties.uid === uid) || null,
  } as unknown as KnowledgeGraph;
}

describe('FilePathIndex', () => {
  let index: FilePathIndex;
  
  beforeEach(() => {
    index = new FilePathIndex();
  });
  
  it('should build index from graph', () => {
    const nodes: GraphNode[] = [
      {
        labels: ['Function'],
        properties: { uid: 'func1', name: 'testFunc', filePath: 'src/test.ts', line: 10 },
      },
      {
        labels: ['Class'],
        properties: { uid: 'class1', name: 'TestClass', filePath: 'src/test.ts', line: 5 },
      },
    ];
    
    const graph = createMockGraph(nodes);
    index.build(graph);
    
    const symbols = index.findSymbolsInFile('src/test.ts');
    expect(symbols).toHaveLength(2);
    expect(symbols[0].properties.name).toBe('TestClass'); // Sorted by line
    expect(symbols[1].properties.name).toBe('testFunc');
  });
  
  it('should return empty array for unknown file', () => {
    const nodes: GraphNode[] = [];
    const graph = createMockGraph(nodes);
    index.build(graph);
    
    expect(index.findSymbolsInFile('unknown.ts')).toEqual([]);
  });
  
  it('should return correct stats', () => {
    const nodes: GraphNode[] = [
      { labels: ['Function'], properties: { uid: 'f1', filePath: 'a.ts', line: 1 } },
      { labels: ['Function'], properties: { uid: 'f2', filePath: 'a.ts', line: 10 } },
      { labels: ['Function'], properties: { uid: 'f3', filePath: 'b.ts', line: 1 } },
    ];
    
    const graph = createMockGraph(nodes);
    index.build(graph);
    
    const stats = index.getStats();
    expect(stats.files).toBe(2);
    expect(stats.symbols).toBe(3);
  });
  
  it('should not rebuild if already built', () => {
    const nodes: GraphNode[] = [
      { labels: ['Function'], properties: { uid: 'f1', filePath: 'a.ts', line: 1 } },
    ];
    
    const graph = createMockGraph(nodes);
    index.build(graph);
    index.build(graph); // Second call
    
    expect(index.getStats().symbols).toBe(1);
  });
  
  it('should clear index', () => {
    const nodes: GraphNode[] = [
      { labels: ['Function'], properties: { uid: 'f1', filePath: 'a.ts', line: 1 } },
    ];
    
    const graph = createMockGraph(nodes);
    index.build(graph);
    index.clear();
    
    expect(index.findSymbolsInFile('a.ts')).toEqual([]);
  });
});
```

- [ ] **Step 3: 运行测试**

```bash
npm test -- tests/unit/diff-degradation.test.ts tests/unit/file-path-index.test.ts
```

Expected: 所有测试通过

- [ ] **Step 4: Commit**

```bash
git add tests/unit/diff-degradation.test.ts tests/unit/file-path-index.test.ts
git commit -m "test(degradation): add unit tests for degradation logic"
```

---

## Task 8: 添加集成测试

**Files:**
- Create: `tests/integration/large-diff-degradation.test.ts`

- [ ] **Step 1: 创建集成测试**

```typescript
// tests/integration/large-diff-degradation.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

describe('Large Diff Degradation Integration', () => {
  let testDir: string;
  
  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'gitnexus-degradation-'));
    
    // Initialize git repo
    await execFileAsync('git', ['init'], { cwd: testDir });
    await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: testDir });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: testDir });
    
    // Create initial commit
    await writeFile(join(testDir, 'initial.txt'), 'initial content');
    await execFileAsync('git', ['add', '.'], { cwd: testDir });
    await execFileAsync('git', ['commit', '-m', 'Initial commit'], { cwd: testDir });
  });
  
  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });
  
  it('should handle large unstaged changes with degradation', async () => {
    // Create a large file
    const largeContent = 'x'.repeat(600 * 1024); // 600KB
    await writeFile(join(testDir, 'large.txt'), largeContent);
    
    // Run detect-changes
    const { stdout } = await execFileAsync(
      'npx',
      ['gitnexus', 'detect-changes', '--scope', 'unstaged'],
      { cwd: testDir, encoding: 'utf8' },
    );
    
    const result = JSON.parse(stdout);
    
    // Should return degraded response
    expect(result.truncated).toBe(true);
    expect(result.precision).toBeDefined();
    expect(result.stats).toBeDefined();
    expect(result.stats.total_files).toBeGreaterThan(0);
    expect(result.suggestion).toBeDefined();
  });
  
  it('should support file filter for drill-down', async () => {
    // Create multiple files
    await writeFile(join(testDir, 'file1.txt'), 'content1');
    await writeFile(join(testDir, 'file2.txt'), 'content2');
    
    // Run with file filter
    const { stdout } = await execFileAsync(
      'npx',
      ['gitnexus', 'detect-changes', '--file', 'file1.txt'],
      { cwd: testDir, encoding: 'utf8' },
    );
    
    const result = JSON.parse(stdout);
    
    // Should only include file1.txt
    if (result.files) {
      expect(result.files.some((f: { path: string }) => f.path.includes('file1.txt'))).toBe(true);
    }
    if (result.changed_files) {
      expect(result.changed_files.some((f: string) => f.includes('file1.txt'))).toBe(true);
    }
  });
  
  it('should respect custom thresholds', async () => {
    const largeContent = 'x'.repeat(100 * 1024); // 100KB
    await writeFile(join(testDir, 'threshold.txt'), largeContent);
    
    // Run with very low threshold (should trigger degradation)
    const { stdout } = await execFileAsync(
      'npx',
      ['gitnexus', 'detect-changes', '--normal-max', '1000'],
      { cwd: testDir, encoding: 'utf8' },
    );
    
    const result = JSON.parse(stdout);
    
    // Should be degraded due to low threshold
    expect(result.truncated).toBe(true);
  });
  
  it('should handle ENOBUFS gracefully', async () => {
    // Create an extremely large file (simulating ENOBUFS scenario)
    // Note: This test may be slow, so we use a moderate size
    const hugeContent = 'x'.repeat(3 * 1024 * 1024); // 3MB
    await writeFile(join(testDir, 'huge.txt'), hugeContent);
    
    const { stdout } = await execFileAsync(
      'npx',
      ['gitnexus', 'detect-changes'],
      { cwd: testDir, encoding: 'utf8' },
    );
    
    const result = JSON.parse(stdout);
    
    // Should not crash, should return file-level degradation
    expect(result).toBeDefined();
    expect(result.truncated).toBe(true);
    expect(result.precision).toBe('file-level');
  });
});
```

- [ ] **Step 2: 运行集成测试**

```bash
npm test -- tests/integration/large-diff-degradation.test.ts
```

Expected: 所有测试通过

- [ ] **Step 3: Commit**

```bash
git add tests/integration/large-diff-degradation.test.ts
git commit -m "test(degradation): add integration tests for ENOBUFS handling"
```

---

## Task 9: 更新文档

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: 更新 CLAUDE.md**

在 GitNexus 规则部分添加降级说明：

```markdown
## Large Diff Degradation

When analyzing large changes (>512KB diff), `detect_changes` automatically degrades to preserve functionality:

| Precision | Trigger | Returns |
|-----------|---------|---------|
| **normal** | ≤512KB | File + line changes + exact symbols |
| **symbol-level** | 512KB-2MB | File + all symbols in file |
| **file-level** | >2MB | File list only |

**Drill-down for specific files:**
```bash
gitnexus detect-changes --file src/auth/login.ts
```

**Force precision level:**
```bash
gitnexus detect-changes --precision symbol-level
```

**Custom thresholds (environment variables):**
```bash
GITNEXUS_DIFF_NORMAL_MAX=1048576 gitnexus detect-changes
```
```

- [ ] **Step 2: 更新 README.md**

在 CLI 命令部分添加：

```markdown
### Large Diff Handling

GitNexus automatically handles large diffs gracefully:

```bash
# Normal usage - auto-degrades if needed
gitnexus detect-changes

# Drill down to specific file
gitnexus detect-changes --file src/auth/login.ts

# Force specific precision
gitnexus detect-changes --precision symbol-level

# Custom thresholds
gitnexus detect-changes --normal-max 1048576 --symbol-max 4194304
```

Configuration via `.gitnexus/degradation.json`:
```json
{
  "normalMaxBytes": 524288,
  "symbolLevelMaxBytes": 2097152,
  "enableSymbolLevel": true
}
```
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: add documentation for large diff degradation"
```

---

## Task 10: 最终集成和测试

**Files:**
- All modified files

- [ ] **Step 1: 运行完整测试套件**

```bash
npm test
```

Expected: 所有测试通过

- [ ] **Step 2: 运行类型检查**

```bash
npx tsc --noEmit
```

Expected: 无错误

- [ ] **Step 3: 运行 lint**

```bash
npm run lint
```

Expected: 无错误

- [ ] **Step 4: 手动测试大 diff 场景**

```bash
# Create a large change
echo "$(head -c 600000 /dev/zero | tr '\0' 'x')" > test-large.txt

# Run detect-changes
npx gitnexus detect-changes

# Expected: degraded response with stats
```

- [ ] **Step 5: 清理测试文件**

```bash
rm test-large.txt
```

- [ ] **Step 6: 最终 commit**

```bash
git add -A
git commit -m "feat(degradation): complete large diff safe degradation implementation

- Add three-tier precision degradation (normal/symbol-level/file-level)
- Add FilePathIndex for O(1) symbol lookup
- Add parseDiffWithDegradation with multi-layer fallback
- Add CLI options for degradation control
- Add configuration file support
- Add comprehensive unit and integration tests
- Update documentation

Resolves: ENOBUFS error on large diffs"
```

---

## 完成标准

- [ ] 所有单元测试通过
- [ ] 所有集成测试通过
- [ ] 类型检查无错误
- [ ] Lint 无错误
- [ ] 手动测试大 diff 场景成功
- [ ] 文档已更新
- [ ] 所有 commits 已推送到分支