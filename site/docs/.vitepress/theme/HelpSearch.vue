<script setup>
import { useData } from 'vitepress'
import { ref } from 'vue'
import { onKeyStroke } from '@vueuse/core'

const { lang } = useData()
const trigger = ref(null)
onKeyStroke('Escape', event => {
  if (event.target instanceof Element && event.target.closest('.VPLocalSearchBox')) {
    requestAnimationFrame(() => trigger.value?.focus())
  }
})

function openSearch() {
  document.querySelector('.VPNavBarSearch .DocSearch-Button')?.click()
}
</script>

<template>
  <button ref="trigger" class="help-search" type="button" @click="openSearch">
    <span class="vp-icon DocSearch-Search-Icon" aria-hidden="true" />
    {{ lang === 'zh-CN' ? '搜索帮助中心' : 'Search the Help Center' }}
    <kbd aria-hidden="true">/</kbd>
  </button>
</template>
