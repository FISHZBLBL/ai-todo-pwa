<script setup lang="ts">
defineProps<{ label: string; active?: boolean; danger?: boolean }>()
</script>
<template><button class="icon-button" :class="{ active, danger }" :aria-label="label" :title="label"><slot /></button></template>
