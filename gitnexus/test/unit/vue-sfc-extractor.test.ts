import { describe, it, expect } from 'vitest';
import {
  extractVueScript,
  extractTemplateComponents,
  extractTemplateEventHandlers,
} from '../../src/core/ingestion/vue-sfc-extractor.js';

describe('extractVueScript', () => {
  it('extracts <script setup lang="ts"> content', () => {
    const vue = `<template>
  <div>Hello</div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const count = ref(0);
</script>
`;
    const result = extractVueScript(vue);
    expect(result).not.toBeNull();
    expect(result!.isSetup).toBe(true);
    expect(result!.scriptContent).toContain("import { ref } from 'vue'");
    expect(result!.scriptContent).toContain('const count = ref(0)');
    // Line 0-3 is template + blank, line 4 is <script setup>, content starts at line 5
    expect(result!.lineOffset).toBe(5);
  });

  it('extracts <script lang="ts"> (non-setup)', () => {
    const vue = `<template>
  <div>Hello</div>
</template>

<script lang="ts">
export default {
  name: 'MyComponent',
};
</script>
`;
    const result = extractVueScript(vue);
    expect(result).not.toBeNull();
    expect(result!.isSetup).toBe(false);
    expect(result!.scriptContent).toContain('export default');
  });

  it('prefers <script setup> when both blocks exist', () => {
    const vue = `<script lang="ts">
export default {
  inheritAttrs: false,
};
</script>

<script setup lang="ts">
import { ref } from 'vue';
const name = ref('test');
</script>

<template><div /></template>
`;
    const result = extractVueScript(vue);
    expect(result).not.toBeNull();
    expect(result!.isSetup).toBe(true);
    expect(result!.scriptContent).toContain("const name = ref('test')");
    expect(result!.scriptContent).not.toContain('inheritAttrs');
  });

  it('returns null for .vue files with no <script> block', () => {
    const vue = `<template>
  <div>Hello</div>
</template>

<style scoped>
div { color: red; }
</style>
`;
    expect(extractVueScript(vue)).toBeNull();
  });

  it('handles <script> without lang attribute', () => {
    const vue = `<template><div /></template>

<script>
export default { name: 'NoLang' };
</script>
`;
    const result = extractVueScript(vue);
    expect(result).not.toBeNull();
    expect(result!.scriptContent).toContain('NoLang');
    expect(result!.isSetup).toBe(false);
  });

  it('handles <script setup> without lang attribute', () => {
    const vue = `<template><div /></template>

<script setup>
const x = 1;
</script>
`;
    const result = extractVueScript(vue);
    expect(result).not.toBeNull();
    expect(result!.isSetup).toBe(true);
    expect(result!.scriptContent).toContain('const x = 1');
  });

  it('computes correct lineOffset for script at top of file', () => {
    const vue = `<script setup lang="ts">
const x = 1;
</script>

<template><div /></template>
`;
    const result = extractVueScript(vue);
    expect(result).not.toBeNull();
    // <script> tag is line 0, content starts at line 1
    expect(result!.lineOffset).toBe(1);
  });

  it('handles multiline script tag attributes', () => {
    const vue = `<template><div /></template>

<script
  setup
  lang="ts"
>
import { ref } from 'vue';
</script>
`;
    const result = extractVueScript(vue);
    expect(result).not.toBeNull();
    expect(result!.isSetup).toBe(true);
    expect(result!.scriptContent).toContain("import { ref } from 'vue'");
  });
});

describe('extractTemplateComponents', () => {
  it('finds PascalCase component tags', () => {
    const vue = `<template>
  <div>
    <MyButton @click="doSomething" />
    <AppHeader title="hello" />
    <span>text</span>
  </div>
</template>

<script setup lang="ts">
// ...
</script>
`;
    const components = extractTemplateComponents(vue);
    expect(components).toContain('MyButton');
    expect(components).toContain('AppHeader');
    expect(components).not.toContain('div');
    expect(components).not.toContain('span');
  });

  it('returns empty array when no template', () => {
    const vue = `<script setup lang="ts">
const x = 1;
</script>
`;
    expect(extractTemplateComponents(vue)).toEqual([]);
  });

  it('deduplicates repeated component usage', () => {
    const vue = `<template>
  <MyButton />
  <MyButton />
  <MyButton />
</template>
`;
    const components = extractTemplateComponents(vue);
    expect(components.filter((c) => c === 'MyButton')).toHaveLength(1);
  });

  it('ignores HTML elements and lowercase tags', () => {
    const vue = `<template>
  <div>
    <p>text</p>
    <router-view />
    <transition name="fade">
      <MyComponent />
    </transition>
  </div>
</template>
`;
    const components = extractTemplateComponents(vue);
    expect(components).toEqual(['MyComponent']);
  });

  it('extracts simple dynamic component identifiers from :is bindings', () => {
    const vue = `<template>
  <component :is="Button" />
  <component :is="'Badge'" />
  <component :is='"Avatar"' />
</template>
`;
    const components = extractTemplateComponents(vue);
    expect(components).toContain('Button');
    expect(components).toContain('Badge');
    expect(components).toContain('Avatar');
  });

  it('ignores non-component dynamic expressions', () => {
    const vue = `<template>
  <component :is="currentComponent" />
  <component :is="isPrimary ? Button : LinkButton" />
</template>
`;
    const components = extractTemplateComponents(vue);
    expect(components).not.toContain('currentComponent');
    expect(components).not.toContain('isPrimary');
  });
});

describe('extractTemplateEventHandlers', () => {
  it('extracts @event handler names', () => {
    const vue = `<template>
  <button @click="handleClick">Submit</button>
  <input @keyup="onKeyUp" />
</template>
`;
    const handlers = extractTemplateEventHandlers(vue);
    expect(handlers).toContain('handleClick');
    expect(handlers).toContain('onKeyUp');
  });

  it('extracts v-on:event handler names', () => {
    const vue = `<template>
  <button v-on:click="submitForm">Submit</button>
</template>
`;
    const handlers = extractTemplateEventHandlers(vue);
    expect(handlers).toContain('submitForm');
  });

  it('deduplicates repeated handler usage', () => {
    const vue = `<template>
  <button @click="handleClick">A</button>
  <button @click="handleClick">B</button>
</template>
`;
    const handlers = extractTemplateEventHandlers(vue);
    expect(handlers.filter((h) => h === 'handleClick')).toHaveLength(1);
  });

  it('ignores inline expressions with operators', () => {
    const vue = `<template>
  <button @click="count++">Inc</button>
  <button @click="isOpen = !isOpen">Toggle</button>
  <button @click="doSomething">OK</button>
</template>
`;
    const handlers = extractTemplateEventHandlers(vue);
    expect(handlers).toContain('doSomething');
    expect(handlers).not.toContain('count++');
  });

  it('returns empty array when no template block', () => {
    const vue = `<script setup lang="ts">
const x = 1;
</script>
`;
    expect(extractTemplateEventHandlers(vue)).toEqual([]);
  });

  it('handles method calls with arguments', () => {
    const vue = `<template>
  <button @click="handleClick(item)">OK</button>
</template>
`;
    const handlers = extractTemplateEventHandlers(vue);
    expect(handlers).toContain('handleClick');
  });
});
