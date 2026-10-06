<template>
  <span v-if="maxLength" class="mention-text">{{ truncatedText }}</span>
  <span v-else class="mention-text">
    <template v-for="(segment, index) in segments" :key="index">
      <template v-if="segment.kind === 'text'">{{ segment.text }}</template>
      <span
        v-else-if="plain || !isPreviewable(segment.type)"
        class="mention-name"
      >{{ segment.name }}</span>
      <span
        v-else
        class="mention-badge"
        :style="{ backgroundColor: getEntityColor(segment.type) }"
        role="button"
        tabindex="0"
        @click.stop="openPreview(segment.type, segment.id)"
        @keydown.enter.stop="openPreview(segment.type, segment.id)"
      ><v-icon :icon="getEntityIcon(segment.type)" size="x-small" />{{ segment.name }}</span>
    </template>

    <EntityPreviewDialog
      v-if="previewEntityId !== null"
      v-model="showPreview"
      :entity-id="previewEntityId"
      :entity-type="previewEntityType"
    />
  </span>
</template>

<script setup lang="ts">
import type { EntityPreviewType } from './EntityPreviewDialog.vue'
import { splitMentions } from '~/utils/mentions'

// Async: EntityPreviewDialog renders descriptions with this component itself
const EntityPreviewDialog = defineAsyncComponent(() => import('./EntityPreviewDialog.vue'))

const props = withDefaults(defineProps<{
  text: string | null | undefined
  /** Names only, no clickable badges (e.g. clamped card previews) */
  plain?: boolean
  /** Truncate to this many characters (after resolving names) and append "..." */
  maxLength?: number
}>(), {
  plain: false,
  maxLength: undefined,
})

const entitiesStore = useEntitiesStore()
const campaignStore = useCampaignStore()

const PREVIEWABLE_TYPES: EntityPreviewType[] = ['npc', 'location', 'item', 'faction', 'lore', 'player']

function isPreviewable(type: string): type is EntityPreviewType {
  return (PREVIEWABLE_TYPES as string[]).includes(type)
}

const segments = computed(() =>
  splitMentions(props.text).map(segment =>
    segment.kind === 'text'
      ? segment
      : { ...segment, name: resolveEntityName(segment.type, segment.id) ?? segment.label ?? segment.raw },
  ),
)

const truncatedText = computed(() => {
  const text = segments.value.map(s => (s.kind === 'text' ? s.text : s.name)).join('')
  return props.maxLength && text.length > props.maxLength ? `${text.substring(0, props.maxLength)}...` : text
})

function resolveEntityName(type: string, id: number): string | null {
  switch (type) {
    case 'npc':
      return entitiesStore.npcs.find(e => e.id === id)?.name ?? null
    case 'location':
      return entitiesStore.locations.find(e => e.id === id)?.name ?? null
    case 'item':
      return entitiesStore.items.find(e => e.id === id)?.name ?? null
    case 'faction':
      return entitiesStore.factions.find(e => e.id === id)?.name ?? null
    case 'lore':
      return entitiesStore.lore.find(e => e.id === id)?.name ?? null
    case 'player':
      return entitiesStore.players.find(e => e.id === id)?.name ?? null
    default:
      return null
  }
}

// Load the entity lists needed to resolve names (the store skips loaded ones)
function loadMentionedTypes() {
  const campaignId = campaignStore.activeCampaignId
  if (!campaignId) return

  const types = new Set(splitMentions(props.text).flatMap(s => (s.kind === 'mention' ? [s.type] : [])))
  const loaders: Record<string, { loaded: boolean, loading: boolean, load: () => Promise<void> }> = {
    npc: { loaded: entitiesStore.npcsLoaded, loading: entitiesStore.npcsLoading, load: () => entitiesStore.fetchNPCs(campaignId) },
    location: { loaded: entitiesStore.locationsLoaded, loading: entitiesStore.locationsLoading, load: () => entitiesStore.fetchLocations(campaignId) },
    item: { loaded: entitiesStore.itemsLoaded, loading: entitiesStore.itemsLoading, load: () => entitiesStore.fetchItems(campaignId) },
    faction: { loaded: entitiesStore.factionsLoaded, loading: entitiesStore.factionsLoading, load: () => entitiesStore.fetchFactions(campaignId) },
    lore: { loaded: entitiesStore.loreLoaded, loading: entitiesStore.loreLoading, load: () => entitiesStore.fetchLore(campaignId) },
    player: { loaded: entitiesStore.playersLoaded, loading: entitiesStore.playersLoading, load: () => entitiesStore.fetchPlayers(campaignId) },
  }

  for (const type of types) {
    const loader = loaders[type]
    // Many cards mount at once - only the first one triggers the fetch
    if (loader && !loader.loaded && !loader.loading) loader.load()
  }
}

watch(() => props.text, loadMentionedTypes, { immediate: true })

function getEntityIcon(type: string): string {
  const icons: Record<string, string> = {
    npc: 'mdi-account',
    location: 'mdi-map-marker',
    item: 'mdi-sword',
    faction: 'mdi-shield',
    lore: 'mdi-book-open-variant',
    player: 'mdi-account-star',
  }
  return icons[type] || 'mdi-link'
}

function getEntityColor(type: string): string {
  const colors: Record<string, string> = {
    npc: '#D4A574',
    location: '#8B7355',
    item: '#CC8844',
    faction: '#7B92AB',
    lore: '#9C6B98',
    player: '#4CAF50',
  }
  return colors[type] || '#888888'
}

// Entity preview
const showPreview = ref(false)
const previewEntityId = ref<number | null>(null)
const previewEntityType = ref<EntityPreviewType>('npc')

function openPreview(type: string, id: number) {
  if (!isPreviewable(type)) return
  previewEntityType.value = type
  previewEntityId.value = id
  showPreview.value = true
}
</script>

<style scoped>
.mention-name {
  font-weight: 500;
}

.mention-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  border-radius: 12px;
  color: white;
  font-size: 0.875em;
  cursor: pointer;
  vertical-align: baseline;
}

.mention-badge:hover,
.mention-badge:focus-visible {
  filter: brightness(1.1);
}
</style>
