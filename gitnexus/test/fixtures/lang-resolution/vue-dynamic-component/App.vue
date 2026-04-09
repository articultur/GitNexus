<template>
  <section>
    <component :is="Button" />
    <component :is="'Button'" />
    <component :is='"Button"' />
  </section>
</template>

<script setup lang="ts">
import Button from './components/Button.vue';
</script>