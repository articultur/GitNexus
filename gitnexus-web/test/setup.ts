import { beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

// Reset storage between tests.
// Guard: Node v25+ exposes a native `localStorage` that lacks Web Storage
// methods when no --localstorage-file is configured; jsdom normally overrides
// it but the guard prevents crashes in environments where it does not.
beforeEach(() => {
  if (typeof sessionStorage?.removeItem === 'function') {
    sessionStorage.removeItem('gitnexus-llm-settings');
  }
  if (typeof localStorage?.removeItem === 'function') {
    localStorage.removeItem('gitnexus-llm-settings'); // legacy key (migration)
  }
});
