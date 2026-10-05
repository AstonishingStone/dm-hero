import { defineStore } from 'pinia'
import type { StoryNode, StoryNodeKind, StoryNodeLinks, StoryNodeListItem } from '~~/types/story'

export interface StoryTreeNode extends StoryNodeListItem {
  children: StoryTreeNode[]
}

// The campaign manager's tree (GM-only scenario prep)
export const useStoryStore = defineStore('story', {
  state: () => ({
    nodes: [] as StoryNodeListItem[],
    loading: false,
    lastFetchedCampaignId: null as number | null,
  }),

  getters: {
    // Nested tree built from the flat list (ordered by sort_order)
    tree: (state): StoryTreeNode[] => {
      const byId = new Map<number, StoryTreeNode>()
      for (const n of state.nodes) byId.set(n.id, { ...n, children: [] })
      const roots: StoryTreeNode[] = []
      for (const n of [...byId.values()].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)) {
        const parent = n.parent_id !== null ? byId.get(n.parent_id) : undefined
        if (parent) parent.children.push(n)
        else roots.push(n)
      }
      return roots
    },
    byId: state => (id: number) => state.nodes.find(n => n.id === id),

    // Reading order (depth-first, like the tree shows it) - for previous/next
    ordered(): StoryNodeListItem[] {
      const result: StoryNodeListItem[] = []
      const walk = (nodes: StoryTreeNode[]) => {
        for (const n of nodes) {
          result.push(n)
          walk(n.children)
        }
      }
      walk(this.tree)
      return result
    },

    // Root first, without the node itself
    ancestors: state => (id: number): StoryNodeListItem[] => {
      const chain: StoryNodeListItem[] = []
      let current = state.nodes.find(n => n.id === id)
      while (current?.parent_id) {
        current = state.nodes.find(n => n.id === current!.parent_id)
        if (current) chain.unshift(current)
      }
      return chain
    },

    // Per node with scenes below it: how many of them are done (played or skipped)
    progress(): Map<number, { done: number, total: number }> {
      const result = new Map<number, { done: number, total: number }>()
      const count = (node: StoryTreeNode): { done: number, total: number } => {
        const sum = { done: 0, total: 0 }
        for (const child of node.children) {
          if (child.kind === 'scene') {
            sum.total++
            if (child.status === 'played' || child.status === 'skipped') sum.done++
          }
          const below = count(child)
          sum.done += below.done
          sum.total += below.total
        }
        if (sum.total > 0) result.set(node.id, sum)
        return sum
      }
      this.tree.forEach(count)
      return result
    },
  },

  actions: {
    async fetchNodes(campaignId: number) {
      this.loading = true
      try {
        this.nodes = await $fetch<StoryNodeListItem[]>('/api/story', { query: { campaignId } })
        this.lastFetchedCampaignId = campaignId
      }
      catch (error) {
        console.error('Failed to fetch story nodes:', error)
        this.nodes = []
      }
      finally {
        this.loading = false
      }
    },

    async refresh() {
      if (this.lastFetchedCampaignId) await this.fetchNodes(this.lastFetchedCampaignId)
    },

    async createNode(campaignId: number, name: string, kind: StoryNodeKind, parentId: number | null) {
      const node = await $fetch<StoryNode>('/api/story', {
        method: 'POST',
        body: { campaignId, name, kind, parentId },
      })
      await this.fetchNodes(campaignId)
      return node
    },

    async updateNode(id: number, patch: Record<string, unknown>) {
      const node = await $fetch<StoryNode>(`/api/story/${id}`, { method: 'PATCH', body: patch })
      this.applyNode(node)
      return node
    },

    async setLinks(id: number, links: StoryNodeLinks) {
      const node = await $fetch<StoryNode>(`/api/story/${id}/links`, { method: 'PUT', body: links })
      this.applyNode(node)
      return node
    },

    async deleteNode(id: number) {
      const { deletedIds } = await $fetch<{ deletedIds: number[] }>(`/api/story/${id}`, { method: 'DELETE' })
      this.nodes = this.nodes.filter(n => !deletedIds.includes(n.id))
      return deletedIds
    },

    async moveNode(id: number, parentId: number | null, index: number) {
      try {
        this.nodes = await $fetch<StoryNodeListItem[]>('/api/story/move', {
          method: 'POST',
          body: { id, parentId, index },
        })
      }
      catch (error) {
        // Drop the optimistic drag result
        await this.refresh()
        throw error
      }
    },

    // Keep the list entry in sync after editing a node
    applyNode(node: StoryNode) {
      const item = this.nodes.find(n => n.id === node.id)
      if (!item) return
      item.name = node.name
      item.kind = node.metadata.kind ?? item.kind
      item.status = node.metadata.status ?? item.status
      item.session_count = node.sessions.length
      item.encounter_count = node.encounters.length
      item.map_count = node.maps.length
    },
  },
})
