import { type Ref, ref } from 'vue'

/** One shared copy of a server list per page load: fetched on first use, fetched again after a failure. */
export function sharedList<T>(fetchList: () => Promise<T[]>) {
  const items = ref([]) as Ref<T[]>
  const error = ref<string>()
  let loading: Promise<void> | undefined

  function load(): Promise<void> {
    loading ??= fetchList()
      .then((list) => {
        items.value = list
        error.value = undefined
      })
      .catch((err: unknown) => {
        error.value = err instanceof Error ? err.message : String(err)
        loading = undefined
      })
    return loading
  }

  return { items, error, load }
}
