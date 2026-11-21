<script setup>
import { useData } from 'vitepress'

const { lang } = useData()

function openSearch() {
  document.querySelector('.VPNavBarSearch .DocSearch-Button')?.click()
}
</script>

<template>
  <button class="help-search" type="button" @click="openSearch">
    <span class="vp-icon DocSearch-Search-Icon" aria-hidden="true" />
    {{ lang === 'zh-CN' ? '搜索 Piik 文档中心' : 'Search Piik Documentation' }}
    <kbd aria-hidden="true">/</kbd>
  </button>
</template>
