<script setup lang="ts">
defineProps<{ title: string; wide?: boolean }>()
const emit = defineEmits<{ close: [] }>()
</script>
<template><div class="sheet-backdrop" @mousedown.self="emit('close')"><section class="sheet" :class="{ wide }" role="dialog" aria-modal="true"><div class="sheet-handle"/><header class="sheet-header"><h2>{{ title }}</h2><button class="close" aria-label="关闭" @click="emit('close')">×</button></header><slot /></section></div></template>
