/**
 * Unit tests for the SQL Injection, Path Traversal, and XSS detection rules.
 */

import { describe, expect, it } from 'vitest';
import { sqlInjectionRule } from '../../../src/core/detection/rules/sql-injection.js';
import { pathTraversalRule } from '../../../src/core/detection/rules/path-traversal.js';
import { xssRule } from '../../../src/core/detection/rules/xss.js';
import type { RuleContext } from '../../../src/core/detection/types.js';

const makeCtx = (
  content: string,
  language: string,
  name = 'testFn',
  filePath = 'test.ts',
): RuleContext => ({
  node: { id: 'fn:1', label: 'Function' as any, properties: { content, name, filePath } },
  outgoingRelationships: [],
  incomingRelationships: [],
  outgoingTargets: new Map(),
  language,
});

// ── SQL Injection ─────────────────────────────────────────────────────────────

describe('sql-injection rule', () => {
  it('has correct id, severity, and confidence', () => {
    expect(sqlInjectionRule.definition.id).toBe('detection:sql-injection');
    expect(sqlInjectionRule.definition.severity).toBe('critical');
    expect(sqlInjectionRule.definition.confidence).toBeGreaterThan(0);
    expect(sqlInjectionRule.definition.confidence).toBeLessThanOrEqual(1);
  });

  it('returns null for empty content', () => {
    expect(sqlInjectionRule.evaluate(makeCtx('', 'typescript'))).toBeNull();
  });

  it('returns null when no SQL keywords present', () => {
    const code = 'const x = user + name; const result = query(x);';
    expect(sqlInjectionRule.evaluate(makeCtx(code, 'typescript'))).toBeNull();
  });

  it('detects TypeScript template literal SQL injection', () => {
    const code = 'const rows = await db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);';
    const result = sqlInjectionRule.evaluate(makeCtx(code, 'typescript'));
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('detection:sql-injection');
    expect(result!.severity).toBe('critical');
  });

  it('detects JavaScript string concatenation SQL injection', () => {
    const code = `const sql = "SELECT * FROM users WHERE name = '" + req.body.name + "'";`;
    const result = sqlInjectionRule.evaluate(makeCtx(code, 'javascript'));
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('detection:sql-injection');
  });

  it('detects Python f-string SQL injection', () => {
    const code = `cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")`;
    const result = sqlInjectionRule.evaluate(makeCtx(code, 'python'));
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('detection:sql-injection');
  });

  it('detects Go fmt.Sprintf SQL injection', () => {
    const code = `rows, err := db.Query(fmt.Sprintf("SELECT * FROM users WHERE name = '%s'", name))`;
    const result = sqlInjectionRule.evaluate(makeCtx(code, 'go'));
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('detection:sql-injection');
  });

  it('detects Java string concatenation SQL injection', () => {
    const code = `Statement stmt = conn.createStatement();\nResultSet rs = stmt.executeQuery("SELECT * FROM users WHERE id = " + userId);`;
    const result = sqlInjectionRule.evaluate(makeCtx(code, 'java'));
    expect(result).not.toBeNull();
  });

  it('does not flag TypeScript parameterised query with $1/$2', () => {
    const code = "const rows = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);";
    expect(sqlInjectionRule.evaluate(makeCtx(code, 'typescript'))).toBeNull();
  });

  it('does not flag code without SQL keywords', () => {
    const code = 'const result = `Hello ${name}, welcome!`;';
    expect(sqlInjectionRule.evaluate(makeCtx(code, 'typescript'))).toBeNull();
  });
});

// ── Path Traversal ────────────────────────────────────────────────────────────

describe('path-traversal rule', () => {
  it('has correct id, severity, and confidence', () => {
    expect(pathTraversalRule.definition.id).toBe('detection:path-traversal');
    expect(pathTraversalRule.definition.severity).toBe('high');
    expect(pathTraversalRule.definition.confidence).toBeGreaterThan(0);
    expect(pathTraversalRule.definition.confidence).toBeLessThanOrEqual(1);
  });

  it('returns null for empty content', () => {
    expect(pathTraversalRule.evaluate(makeCtx('', 'typescript'))).toBeNull();
  });

  it('returns null for irrelevant content', () => {
    const code = 'const x = req.params.id; doSomethingWith(x);';
    expect(pathTraversalRule.evaluate(makeCtx(code, 'typescript'))).toBeNull();
  });

  it('detects TypeScript path.join with request params', () => {
    const code = `const filePath = path.join(__dirname, 'uploads', req.params.filename);\nconst data = fs.readFileSync(filePath);`;
    const result = pathTraversalRule.evaluate(makeCtx(code, 'typescript'));
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('detection:path-traversal');
    expect(result!.severity).toBe('high');
  });

  it('detects TypeScript __dirname + user input', () => {
    const code = `const fullPath = __dirname + req.params.file;\nres.sendFile(fullPath);`;
    const result = pathTraversalRule.evaluate(makeCtx(code, 'typescript'));
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('detection:path-traversal');
  });

  it('detects Python os.path.join with user input', () => {
    const code = `filepath = os.path.join(BASE_DIR, request.args.get('filename'))\nwith open(filepath) as f:`;
    const result = pathTraversalRule.evaluate(makeCtx(code, 'python'));
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('detection:path-traversal');
  });

  it('detects Go filepath.Join with HTTP query parameter', () => {
    const code = `
func handler(w http.ResponseWriter, r *http.Request) {
  file := r.URL.Query().Get("file")
  p := filepath.Join(rootDir, file)
  http.ServeFile(w, r, p)
}`;
    const result = pathTraversalRule.evaluate(makeCtx(code, 'go'));
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('detection:path-traversal');
  });

  it('does not flag path.join when startsWith validation is present', () => {
    const code = `
const userFile = req.params.name;
const full = path.join(__dirname, 'uploads', userFile);
if (!full.startsWith(path.join(__dirname, 'uploads'))) { throw new Error('invalid'); }
const data = fs.readFileSync(full);`;
    expect(pathTraversalRule.evaluate(makeCtx(code, 'typescript'))).toBeNull();
  });

  it('does not flag code with sanitize call nearby', () => {
    const code = `
const safe = sanitize(req.params.file);
const p = path.join(uploadDir, safe);
res.sendFile(p);`;
    expect(pathTraversalRule.evaluate(makeCtx(code, 'typescript'))).toBeNull();
  });
});

// ── XSS ──────────────────────────────────────────────────────────────────────

describe('xss rule', () => {
  it('has correct id, severity, and confidence', () => {
    expect(xssRule.definition.id).toBe('detection:xss');
    expect(xssRule.definition.severity).toBe('high');
    expect(xssRule.definition.confidence).toBeGreaterThan(0);
    expect(xssRule.definition.confidence).toBeLessThanOrEqual(1);
  });

  it('returns null for empty content', () => {
    expect(xssRule.evaluate(makeCtx('', 'typescript'))).toBeNull();
  });

  it('returns null when no XSS patterns present', () => {
    const code = 'const x = 1 + 2; console.log(x);';
    expect(xssRule.evaluate(makeCtx(code, 'typescript'))).toBeNull();
  });

  it('detects TypeScript innerHTML assignment with request data', () => {
    const code = `element.innerHTML = req.query.name;`;
    const result = xssRule.evaluate(makeCtx(code, 'typescript'));
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('detection:xss');
    expect(result!.severity).toBe('high');
  });

  it('detects JavaScript document.write with request params', () => {
    const code = `document.write(req.query.message);`;
    const result = xssRule.evaluate(makeCtx(code, 'javascript'));
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('detection:xss');
  });

  it('detects PHP echo with raw GET superglobal', () => {
    const code = `echo $_GET["name"];`;
    const result = xssRule.evaluate(makeCtx(code, 'php', 'testFn', 'test.php'));
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('detection:xss');
  });

  it('detects Go template.HTML() cast of URL parameter', () => {
    const code = `title := template.HTML(r.URL.Query().Get("title"))`;
    const result = xssRule.evaluate(makeCtx(code, 'go', 'testFn', 'test.go'));
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('detection:xss');
  });

  it('detects Ruby .html_safe on params', () => {
    const code = `render html: params[:name].html_safe`;
    const result = xssRule.evaluate(makeCtx(code, 'ruby', 'testFn', 'test.rb'));
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('detection:xss');
  });

  it('detects C# Response.Write with QueryString', () => {
    const code = `Response.Write(Request.QueryString["username"]);`;
    const result = xssRule.evaluate(makeCtx(code, 'csharp', 'testFn', 'test.cs'));
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('detection:xss');
  });

  it('detects Python Markup() with user input', () => {
    const code = `return Markup(request.args.get('content'))`;
    const result = xssRule.evaluate(makeCtx(code, 'python', 'testFn', 'test.py'));
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('detection:xss');
  });

  it('does not flag innerHTML with DOMPurify sanitisation nearby', () => {
    const code = `
const clean = DOMPurify.sanitize(req.query.name);
element.innerHTML = clean;`;
    expect(xssRule.evaluate(makeCtx(code, 'typescript'))).toBeNull();
  });

  it('does not flag PHP echo with htmlspecialchars', () => {
    const code = `echo htmlspecialchars($_GET["name"], ENT_QUOTES);`;
    expect(xssRule.evaluate(makeCtx(code, 'php', 'testFn', 'test.php'))).toBeNull();
  });

  it('does not flag .textContent assignment (safe DOM property)', () => {
    const code = `element.textContent = req.query.name;`;
    expect(xssRule.evaluate(makeCtx(code, 'typescript'))).toBeNull();
  });

  it('covers supported languages list', () => {
    const langs = xssRule.definition.languages ?? [];
    expect(langs).toContain('typescript');
    expect(langs).toContain('javascript');
    expect(langs).toContain('python');
    expect(langs).toContain('php');
    expect(langs).toContain('ruby');
    expect(langs).toContain('go');
    expect(langs).toContain('csharp');
    expect(langs).toContain('java');
    expect(langs).toContain('kotlin');
  });
});
