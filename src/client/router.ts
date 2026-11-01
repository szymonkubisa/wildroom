import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'projects', component: () => import('./features/projects/ProjectsPage.vue') },
    { path: '/p/:id', name: 'editor', component: () => import('./features/editor/EditorPage.vue'), props: true },
    { path: '/features', name: 'features', component: () => import('./features/guide/FeaturesPage.vue') },
    { path: '/settings', name: 'settings', component: () => import('./features/settings/SettingsPage.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
