/**
 * Cross-Site Scripting (XSS) Detection Rule
 *
 * Detects user-controlled input being rendered into HTML/DOM without sanitisation,
 * enabling reflected, stored, or DOM-based XSS attacks (OWASP A03:2021 / CWE-79).
 *
 * Identifies patterns like:
 *   - DOM sink:      element.innerHTML = userInput
 *   - document.write: document.write(req.query.name)
 *   - jQuery:        $(el).html(userInput)
 *   - Server-side (Python): Markup(user_input), jinja2.Template(user_input)
 *   - Server-side (Java):   out.println(request.getParameter(...))
 *   - Server-side (PHP):    echo $_GET["param"]
 *   - Server-side (Ruby):   raw(params[:input]), html_safe
 *   - Server-side (Go):     template.HTML(userInput), fmt.Fprint(w, userInput)
 *   - Server-side (C#):     Response.Write(Request.QueryString["x"])
 *
 * Findings are suppressed when the surrounding context includes a known sanitiser
 * (DOMPurify, escapeHtml, htmlspecialchars, html.EscapeString, etc.).
 */

import type { Rule, RuleContext, DetectionResult, Evidence } from '../types.js';

// User-controlled source patterns — heuristic variable/property names
const USER_INPUT_PATTERN =
  /(?:req\.|request\.|params\[|query\[|\$_GET|\$_POST|\$_REQUEST|\$_COOKIE|getParameter|request\.getQuery|r\.URL|r\.Form|r\.PostForm|env\[|CMD_ARGS|process\.env|argv\[|sys\.argv)/i;

// DOM-sink / server-side render patterns per language
const XSS_PATTERNS: Array<{
  pattern: RegExp;
  languages: string[];
  description: string;
}> = [
  // JS/TS DOM sinks: innerHTML / outerHTML
  {
    pattern:
      /(?:\w+|document\.\w+)\s*\.\s*(?:innerHTML|outerHTML)\s*(?:\+=|=)\s*(?!['"`](?:\s*<)?(?:[a-z0-9-]+\s*[/]?>))/i,
    languages: ['typescript', 'javascript'],
    description: 'innerHTML/outerHTML assignment — possible XSS sink',
  },
  // JS/TS document.write with user-derived input
  {
    pattern: /document\.write(?:ln)?\s*\([^)]*(?:req\.|params\.|query\.|body\.|userInput|input)/i,
    languages: ['typescript', 'javascript'],
    description: 'document.write with request-derived input — possible XSS sink',
  },
  // jQuery .html() with user input
  {
    pattern:
      /\$\s*\([^)]+\)\s*\.\s*html\s*\(\s*(?:req\.|params\.|query\.|body\.|userInput|input|\w*[Uu]ser\w*)/i,
    languages: ['typescript', 'javascript'],
    description: 'jQuery .html() with user-controlled argument — possible XSS sink',
  },
  // JS/TS React dangerouslySetInnerHTML with user input
  {
    pattern: /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*(?!DOMPurify)/i,
    languages: ['typescript', 'javascript'],
    description: 'dangerouslySetInnerHTML without DOMPurify — possible XSS sink',
  },
  // Python: Markup() / jinja2.Template(user_input) builds unescaped HTML
  {
    pattern:
      /(?:Markup|jinja2\.Template|Template)\s*\(\s*(?:request\.|args\.|argv\[|input\s*\(|param|query|user_?input)/i,
    languages: ['python'],
    description: 'Markup()/Template() with user-controlled argument — possible XSS sink',
  },
  // Python: Response return with unescaped format string
  {
    pattern:
      /(?:HttpResponse|Response|make_response)\s*\(\s*(?:f"|f').*(?:request\.|args\.|argv\[|param|query)/i,
    languages: ['python'],
    description: 'HttpResponse/Response with f-string interpolation of user input — possible XSS',
  },
  // Java: PrintWriter / response.getWriter().print with getParameter
  {
    pattern:
      /(?:response\.getWriter\s*\(\s*\)|out)\s*\.\s*(?:print|println|write)\s*\([^)]*(?:getParameter|getQueryString|getHeader)/i,
    languages: ['java', 'kotlin'],
    description: 'response.getWriter().println(getParameter(...)) — possible XSS sink',
  },
  // Java: String.format / concatenation with request data in HTML context
  {
    pattern:
      /(?:String\.format|printf)\s*\(\s*"[^"]*<[^"]*%s[^"]*"[^,]*,\s*(?:request\.|getParameter)/i,
    languages: ['java', 'kotlin'],
    description: 'String.format with HTML template and user parameter — possible reflected XSS',
  },
  // PHP: echo / print with raw superglobal
  {
    pattern: /(?:echo|print)\s+(?:\$_(?:GET|POST|REQUEST|COOKIE)|[^;]*\$_(?:GET|POST|REQUEST))/i,
    languages: ['php'],
    description: 'echo/print with unescaped superglobal — possible XSS sink',
  },
  // PHP: header('Location: ') redirect with user input (open redirect + XSS)
  {
    pattern: /header\s*\(\s*['"]Location:\s*['"].*\$_(?:GET|POST|REQUEST|COOKIE)/i,
    languages: ['php'],
    description: 'header(Location:) with user-controlled URL — possible redirect/XSS',
  },
  // Ruby: .html_safe on user input, or raw() with params
  {
    pattern: /(?:params\[|request\.|env\[)[^.]*(?:\.html_safe|\.raw)|raw\s*\(\s*params\[/i,
    languages: ['ruby'],
    description: '.html_safe / raw() with params content — possible XSS sink',
  },
  // Go: template.HTML() cast bypasses escaping
  {
    pattern:
      /template\.HTML\s*\(\s*(?:r\.URL|r\.Form|r\.PostForm|mux\.Vars|chi\.URLParam|fmt\.Sprintf)/i,
    languages: ['go'],
    description: 'template.HTML() cast of user-controlled value — possible XSS sink',
  },
  // Go: fmt.Fprint(w, userInput) writes to response without HTML escaping
  {
    pattern:
      /fmt\.Fprint(?:f|ln)?\s*\(\s*\w+(?:ResponseWriter|w\b)[^,)]*,\s*(?:r\.URL|r\.Form|fmt\.Sprintf\([^)]*r\.)/i,
    languages: ['go'],
    description: 'fmt.Fprintf to ResponseWriter with request data — possible XSS',
  },
  // C#: Response.Write / Page.Response.Write with QueryString
  {
    pattern: /Response\.Write\s*\([^)]*(?:Request\.QueryString|Request\.Form|Request\.Params)/i,
    languages: ['csharp'],
    description: 'Response.Write with Request.QueryString — possible XSS sink',
  },
  // C#: HtmlString / MvcHtmlString without encoding
  {
    pattern:
      /new\s+(?:HtmlString|MvcHtmlString)\s*\([^)]*(?:Request\.QueryString|Request\.Form|userInput|input)/i,
    languages: ['csharp'],
    description: 'new HtmlString() with user-controlled content — possible XSS sink',
  },
];

// Patterns indicating output is properly sanitised (reduce false positives)
const SAFE_PATTERNS: RegExp[] = [
  /DOMPurify\.sanitize/i,
  /escapeHtml\s*\(/i,
  /htmlspecialchars\s*\(/i,
  /htmlentities\s*\(/i,
  /html\.EscapeString\s*\(/i,
  /template\.HTMLEscapeString/i,
  /\.textContent\s*=/, // safe DOM property (no HTML parsing)
  /\.innerText\s*=/, // safe DOM property
  /WebUtility\.HtmlEncode/i, // C# encoding
  /HttpUtility\.HtmlEncode/i, // C# encoding
  /Server\.HtmlEncode/i, // C# WebForms encoding
  /AntiXssEncoder/i, // OWASP AntiSamy / Microsoft.Security.Application
  /sanitize\s*\(/i,
  /sanitise\s*\(/i,
  /ERB::Util\.html_escape/i, // Ruby safe helper
  /\bcgi\.escape_html\b/i, // Ruby CGI helper
  /content_tag\s*\(/i, // Rails safe helper
  /h\s*\(\s*\w/, // Rails short-form escape helper h()
  /markupsafe\.escape/i, // Python MarkupSafe
  /bleach\.clean\s*\(/i, // Python bleach sanitiser
];

/**
 * Check whether a XSS-prone expression is protected by sanitisation.
 */
function hasSanitisation(content: string, matchIndex: number): boolean {
  const start = Math.max(0, matchIndex - 400);
  const end = Math.min(content.length, matchIndex + 400);
  const window = content.slice(start, end);
  return SAFE_PATTERNS.some((p) => p.test(window));
}

export const xssRule: Rule = {
  definition: {
    id: 'detection:xss',
    name: 'Cross-Site Scripting (XSS) risk',
    description:
      'Detects user-controlled input rendered into HTML/DOM without sanitisation — ' +
      'enabling reflected, stored, or DOM-based XSS attacks (OWASP A03:2021 / CWE-79).',
    severity: 'high',
    confidence: 0.7,
    languages: [
      'typescript',
      'javascript',
      'python',
      'java',
      'kotlin',
      'php',
      'ruby',
      'go',
      'csharp',
    ],
    trigger: {
      propertyConditions: [{ property: 'content', operator: 'not_contains', value: '""' }],
    },
    missing: {},
  },

  evaluate(ctx: RuleContext): DetectionResult | null {
    const content = ctx.node.properties.content as string | undefined;
    if (!content || content.length < 10) return null;

    // Quick pre-check: any HTML sink or user-input pattern present?
    const hasHtmlSink =
      /innerHTML|outerHTML|document\.write|\.html\s*\(|dangerouslySetInnerHTML|Markup\s*\(|response\.getWriter|echo\s|html_safe|template\.HTML|Response\.Write|HtmlString/i.test(
        content,
      );
    const hasUserInput = USER_INPUT_PATTERN.test(content);

    if (!hasHtmlSink && !hasUserInput) return null;

    const language = ctx.language;
    const findings: Array<{ match: RegExpMatchArray; description: string }> = [];

    for (const pat of XSS_PATTERNS) {
      if (pat.languages.length > 0 && !pat.languages.includes(language)) continue;

      const re = new RegExp(pat.pattern.source, 'gi');
      let match: RegExpMatchArray | null;
      while ((match = re.exec(content)) !== null) {
        if (!hasSanitisation(content, match.index!)) {
          findings.push({ match, description: pat.description });
        }
        if (findings.length >= 5) break;
      }
      if (findings.length >= 5) break;
    }

    if (findings.length === 0) return null;

    const filePath = (ctx.node.properties.filePath as string) ?? '';
    const name = (ctx.node.properties.name as string) ?? '';

    const evidence: Evidence[] = findings.slice(0, 3).map((f) => ({
      description: f.description,
      symbolId: ctx.node.id,
      symbolName: name,
      filePath,
      relatedSymbols: [],
    }));

    return {
      ruleId: 'detection:xss',
      message: `${name}: ${findings.length} unsanitised HTML output pattern(s) detected — possible XSS`,
      symbolName: name,
      symbolId: ctx.node.id,
      filePath,
      severity: 'high',
      confidence: Math.min(0.85, 0.6 + findings.length * 0.05),
      evidence,
    };
  },
};
