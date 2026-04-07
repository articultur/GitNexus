/**
 * Simple ArkTS fixture — used by tree-sitter-languages.test.ts.
 * Uses TypeScript grammar compatibility (struct → class after preprocessing).
 */

class ArkSession {
  private sessionId: string;

  constructor(id: string) {
    this.sessionId = id;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  isValid(): boolean {
    return this.sessionId.length > 0;
  }
}

function createSession(id: string): ArkSession {
  return new ArkSession(id);
}

export { ArkSession, createSession };
