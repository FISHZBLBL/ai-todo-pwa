<script setup lang="ts">
import { ref } from 'vue'
import { api } from '../services/api'
const emit = defineEmits<{ success: [] }>(); const password = ref(''), error = ref(''), busy = ref(false)
async function login() { busy.value = true; error.value = ''; try { await api.login(password.value); emit('success') } catch (e) { error.value = (e as Error).message } finally { busy.value = false } }
</script>
<template><main class="login-view"><div class="login-mark">✓</div><h1>Todo</h1><p>请输入访问密码</p><form @submit.prevent="login"><input v-model="password" type="password" autocomplete="current-password" autofocus/><p v-if="error" class="form-error">{{ error }}</p><button class="primary large" :disabled="busy">{{ busy ? '验证中…' : '登录' }}</button></form></main></template>
