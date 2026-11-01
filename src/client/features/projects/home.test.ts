import type { ProjectEntry } from '@shared/types/api'
import { describe, expect, it } from 'vitest'
import { filterProjects, matchesQuery, nameFromBrief, type ProjectFilter, tagCounts } from './home'

const entry = (name: string, extra: Partial<ProjectEntry> = {}): ProjectEntry => ({
  path: `/p/${name}.wildroom`,
  name,
  state: 'ok',
  open: false,
  durationFrames: 0,
  recent: true,
  kind: 'edit',
  tags: [],
  status: 'Empty',
  ...extra,
})

const projects = [
  entry('Lake film', { kind: 'film', tags: ['client', 'showreel'], status: '3 scenes · 14 shots', updatedAt: '2026-10-10T10:00:00Z', createdAt: '2026-09-01T00:00:00Z' }),
  entry('Bakery', { kind: 'ad', tags: ['client'], updatedAt: '2026-10-12T10:00:00Z', createdAt: '2026-10-01T00:00:00Z' }),
  entry('Travel reel', { kind: 'edit', open: true, updatedAt: '2026-10-11T10:00:00Z', createdAt: '2026-10-05T00:00:00Z' }),
  entry('Posts', { kind: 'social', tags: ['showreel'], updatedAt: '2026-10-01T10:00:00Z', createdAt: '2026-10-06T00:00:00Z' }),
]
const all: ProjectFilter = { query: '', kind: 'all', tags: [], sort: 'edited', pinned: new Set() }
const names = (list: ProjectEntry[]) => list.map((p) => p.name)

describe('Home projects', () => {
  it('sorts by last edit, newest or name, pinned first', () => {
    expect(names(filterProjects(projects, all))).toEqual(['Bakery', 'Travel reel', 'Lake film', 'Posts'])
    expect(names(filterProjects(projects, { ...all, sort: 'created' }))).toEqual(['Posts', 'Travel reel', 'Bakery', 'Lake film'])
    expect(names(filterProjects(projects, { ...all, sort: 'name' }))).toEqual(['Bakery', 'Lake film', 'Posts', 'Travel reel'])
    expect(names(filterProjects(projects, { ...all, pinned: new Set(['/p/Posts.wildroom']) }))[0]).toBe('Posts')
  })

  it('filters by kind and by every chosen tag', () => {
    expect(names(filterProjects(projects, { ...all, kind: 'film' }))).toEqual(['Lake film'])
    expect(names(filterProjects(projects, { ...all, tags: ['client'] }))).toEqual(['Bakery', 'Lake film'])
    expect(names(filterProjects(projects, { ...all, tags: ['client', 'showreel'] }))).toEqual(['Lake film'])
  })

  it('searches names, tags, status and state, every word', () => {
    expect(matchesQuery(projects[0]!, 'lake shots')).toBe(true)
    expect(matchesQuery(projects[0]!, '#show')).toBe(true)
    expect(matchesQuery(projects[3]!, '#client')).toBe(false)
    expect(matchesQuery(projects[2]!, 'open')).toBe(true)
    expect(matchesQuery(projects[1]!, 'ad')).toBe(true)
    expect(matchesQuery(projects[1]!, 'lake')).toBe(false)
  })

  it('counts tags, the most used first', () => {
    expect(tagCounts(projects)).toEqual([
      { tag: 'client', count: 2 },
      { tag: 'showreel', count: 2 },
    ])
  })

  it('names a project after the start of its brief', () => {
    expect(nameFromBrief('A 45-second film: a boy catches his first fish with his grandfather.', 'film')).toBe('A boy catches his first fish')
    expect(nameFromBrief('Cut my travel clips. Add music.', 'edit')).toBe('Cut my travel clips')
    expect(nameFromBrief('   ', 'social')).toBe('Untitled Social')
    expect(nameFromBrief('cats/dogs: a duel', 'film')).toBe('A duel')
  })
})
