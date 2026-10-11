// A deploy renames the chunks. A page that loaded before it asks for chunks that are gone and gets the
// app shell instead; the only cure is one reload, guarded so a real failure cannot loop.
export function recoverChunk<T>(load: () => Promise<T>): () => Promise<T> {
  return () =>
    load().catch((e: unknown) => {
      const key = "lk_chunk_reload";
      try {
        if (window.sessionStorage.getItem(key) !== "1") {
          window.sessionStorage.setItem(key, "1");
          window.location.reload();
          return new Promise<T>(() => undefined);
        }
      } catch {
        // storage unavailable: fall through
      }
      throw e;
    });
}
