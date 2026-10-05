<template>
  <div class="story-block" :class="[`story-block--${variant}`, { 'story-block--editing': editing, 'story-block--empty': !modelValue.trim() }]">
    <div v-if="label" class="story-block-label d-flex align-center">
      <v-icon v-if="icon" :icon="icon" size="x-small" class="mr-1" />
      {{ label }}
      <v-spacer />
      <Transition name="story-fade">
        <v-btn
          v-if="editing"
          size="small"
          variant="tonal"
          color="primary"
          rounded="pill"
          prepend-icon="mdi-check"
          class="story-done"
          @click="emit('done')"
        >
          {{ $t('story.done') }}
        </v-btn>
      </Transition>
    </div>

    <Transition name="story-swap" mode="out-in" @after-enter="focusEditor">
      <!-- Edit in place -->
      <div v-if="editing" key="edit" class="story-block-edit" @keydown.esc="emit('done')">
        <SharedEntityMarkdownEditor
          ref="editorComp"
          :model-value="modelValue"
          :placeholder="placeholder"
          :sessions="sessions"
          :height="height"
          :preview="false"
          @update:model-value="v => emit('update:modelValue', v)"
          @upload-image="(files, cb) => emit('upload-image', files, cb)"
        />
        <div v-if="!label" class="d-flex justify-end pa-2 pt-1">
          <v-btn
            size="small"
            variant="tonal"
            color="primary"
            rounded="pill"
            prepend-icon="mdi-check"
            class="story-done"
            @click="emit('done')"
          >
            {{ $t('story.done') }}
          </v-btn>
        </div>
      </div>

      <!-- Read: rendered, click anywhere (or Enter) to edit; badges open their preview -->
      <div
        v-else
        key="read"
        class="story-block-read"
        role="button"
        tabindex="0"
        :aria-label="`${label || placeholder} – ${$t('story.clickToEdit')}`"
        @click="onClick"
        @keydown.enter.self.prevent="emit('edit')"
      >
        <ClientOnly v-if="modelValue.trim()">
          <MdPreview
            :key="namesKey"
            :model-value="modelValue"
            :language="locale === 'de' ? 'de-DE' : 'en-US'"
            :theme="theme.global.current.value.dark ? 'dark' : 'light'"
            :sanitize="renderBadges"
            preview-theme="default"
            class="story-preview"
          />
        </ClientOnly>
        <div v-else class="story-block-placeholder d-flex align-center">
          <v-icon icon="mdi-pencil-outline" size="small" class="mr-2" />
          {{ placeholder }}
        </div>
        <span class="story-edit-hint" aria-hidden="true">
          <v-icon icon="mdi-pencil" size="14" />
          {{ $t('story.edit') }}
        </span>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { MdPreview } from 'md-editor-v3'
import 'md-editor-v3/lib/preview.css'
import { useTheme } from 'vuetify'

const props = withDefaults(defineProps<{
  modelValue: string
  editing: boolean
  label?: string
  icon?: string
  placeholder?: string
  variant?: 'plain' | 'boxed' | 'secret'
  height?: string
  /** "type:id" -> display name, for the {{type:id}} badges */
  names?: Record<string, string>
  sessions?: Array<{ id: number, title?: string | null, session_number?: number | null, date?: string | null }>
}>(), {
  label: '',
  icon: '',
  placeholder: '',
  variant: 'plain',
  height: '260px',
  names: () => ({}),
  sessions: () => [],
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'edit': []
  'done': []
  'entity': [type: string, id: number]
  'upload-image': [files: File[], callback: (urls: string[]) => void]
}>()

const { locale } = useI18n()

// Opening a block puts the cursor at the end of its text, ready to type
const editorComp = ref<{ editorRef?: { focus?: (o?: 'start' | 'end') => void } } | null>(null)
function focusEditor() {
  if (!props.editing) return
  const md = editorComp.value?.editorRef
  if (md?.focus) md.focus('end')
}
// The editor mounts client-side; focus once it's there even without a transition
watch(() => props.editing, async (on) => {
  if (!on) return
  await nextTick()
  setTimeout(focusEditor, 200)
})
const theme = useTheme()

const BADGE_COLORS: Record<string, string> = {
  npc: '#D4A574',
  location: '#8B7355',
  item: '#CC8844',
  faction: '#7B92AB',
  lore: '#9C6B98',
  player: '#4CAF50',
  session: '#1976D2',
}
const BADGE_ICONS: Record<string, string> = {
  npc: 'mdi-account',
  location: 'mdi-map-marker',
  item: 'mdi-sword',
  faction: 'mdi-shield',
  lore: 'mdi-book-open-variant',
  player: 'mdi-account-star',
  session: 'mdi-calendar',
}

// The preview only re-renders on text changes - names arriving later need a fresh render
const namesKey = computed(() => Object.entries(props.names).map(([k, v]) => `${k}=${v}`).join('|'))

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]!)

function badge(type: string, id: string) {
  const name = props.names[`${type}:${id}`]
  const color = BADGE_COLORS[type] ?? '#888888'
  const icon = BADGE_ICONS[type] ?? 'mdi-link'
  return `<span class="entity-badge" data-type="${type}" data-id="${id}" style="background-color: ${color}; color: white; padding: 1px 8px; border-radius: 12px; font-size: 0.875rem; display: inline-flex; align-items: center; gap: 4px; cursor: pointer;"><i class="mdi ${icon}"></i>${escapeHtml(name ?? `${type} #${id}`)}</span>`
}

// {{type:id}} (and legacy [Name](type:id)) -> badge; keep heading ids valid
function renderBadges(html: string): string {
  return html
    .replace(/(<h[1-6][^>]*id=")([^"]*)(">)/g, (_m, pre, id, post) => pre + id.replace(/\{\{\w+:\d+\}\}/g, '') + post)
    .replace(/\{\{(\w+):(\d+)\}\}/g, (_m, type, id) => badge(type, id))
    .replace(/<a[^>]*href="(\w+):(\d+)"[^>]*>[^<]+<\/a>/g, (_m, type, id) => badge(type, id))
}

function onClick(event: MouseEvent) {
  const target = event.target as HTMLElement
  const el = target.closest('.entity-badge')
  if (el) {
    event.preventDefault()
    emit('entity', el.getAttribute('data-type')!, Number(el.getAttribute('data-id')))
    return
  }
  // Real links and text selection don't switch to editing
  if (target.closest('a') || window.getSelection()?.toString()) return
  emit('edit')
}
</script>

<style scoped>
.story-block {
  margin-bottom: 14px;
}

.story-block-label {
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: rgba(var(--v-theme-on-surface), 0.6);
  margin-bottom: 4px;
  min-height: 28px;
}

/* --- Read mode: looks like text, clearly clickable on hover/focus --- */
.story-block-read {
  position: relative;
  cursor: text;
  border-radius: 8px;
  padding: 6px 10px;
  margin: 0 -10px;
  outline: none;
  transition: background-color 0.2s ease, box-shadow 0.2s ease;
}

.story-block-read:hover,
.story-block-read:focus-visible {
  background: rgba(var(--v-theme-on-surface), 0.04);
  box-shadow: inset 0 0 0 1px rgba(var(--v-theme-primary), 0.35);
}

.story-block-read:focus-visible {
  box-shadow: inset 0 0 0 2px rgba(var(--v-theme-primary), 0.7);
}

.story-edit-hint {
  position: absolute;
  top: -10px;
  right: 10px;
  z-index: 1;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 500;
  color: rgb(var(--v-theme-on-primary));
  background: rgb(var(--v-theme-primary));
  opacity: 0;
  transform: translateY(-3px) scale(0.95);
  transition: opacity 0.18s ease, transform 0.18s ease;
  pointer-events: none;
}

.story-block-read:hover .story-edit-hint,
.story-block-read:focus-visible .story-edit-hint {
  opacity: 1;
  transform: none;
}

/* Empty: an obvious "start writing here" box */
.story-block--empty .story-block-read {
  margin: 0;
  border: 1px dashed rgba(var(--v-theme-on-surface), 0.25);
}

.story-block--empty .story-block-read:hover {
  border-color: rgba(var(--v-theme-primary), 0.6);
}

.story-block-placeholder {
  min-height: 44px;
  color: rgba(var(--v-theme-on-surface), 0.5);
}

.story-block--empty .story-edit-hint {
  display: none;
}

/* Styled blocks */
.story-block--boxed .story-block-read {
  margin: 0;
  padding: 10px 14px;
  border-left: 4px solid rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.07);
  font-style: italic;
}

.story-block--secret .story-block-read {
  margin: 0;
  padding: 8px 12px;
  border-left: 4px solid rgb(var(--v-theme-error));
  background: rgba(var(--v-theme-error), 0.07);
}

.story-block--boxed .story-block-read:hover {
  background: rgba(var(--v-theme-primary), 0.11);
}

.story-block--secret .story-block-read:hover {
  background: rgba(var(--v-theme-error), 0.11);
  box-shadow: inset 0 0 0 1px rgba(var(--v-theme-error), 0.35);
}

.story-block--secret .story-block-label {
  color: rgb(var(--v-theme-error));
}

/* --- Edit mode: a framed editor --- */
.story-block-edit {
  border-radius: 10px;
  overflow: hidden;
  box-shadow:
    0 0 0 1px rgba(var(--v-theme-primary), 0.55),
    0 6px 24px -8px rgba(var(--v-theme-primary), 0.35);
}

.story-block--secret .story-block-edit {
  box-shadow:
    0 0 0 1px rgba(var(--v-theme-error), 0.55),
    0 6px 24px -8px rgba(var(--v-theme-error), 0.35);
}

.story-done {
  letter-spacing: normal;
  text-transform: none;
}

/* --- Animations --- */
.story-swap-enter-active,
.story-swap-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}

.story-swap-enter-from {
  opacity: 0;
  transform: translateY(4px) scale(0.995);
}

.story-swap-leave-to {
  opacity: 0;
  transform: translateY(-2px);
}

.story-fade-enter-active,
.story-fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.story-fade-enter-from,
.story-fade-leave-to {
  opacity: 0;
  transform: scale(0.9);
}

@media (prefers-reduced-motion: reduce) {
  .story-swap-enter-active,
  .story-swap-leave-active,
  .story-fade-enter-active,
  .story-fade-leave-active,
  .story-block-read,
  .story-edit-hint {
    transition: none;
  }
}

/* The preview brings its own background and padding - blend in */
.story-preview {
  background: transparent !important;
}

.story-preview :deep(.md-editor-preview-wrapper) {
  padding: 0;
}

.story-preview :deep(.md-editor-preview) {
  font-size: 0.95rem;
}

.story-preview :deep(.md-editor-preview > :first-child) {
  margin-top: 0;
}

.story-preview :deep(.md-editor-preview > :last-child) {
  margin-bottom: 0;
}
</style>
