/**
 * Supabase クエリの共通ラッパー（P0-1）。
 *
 * 背景: supabase-js のクエリは、タブ復帰直後の auth トークンリフレッシュ競合や
 * ネットワーク断で「永久に resolve しない」ことがあり、呼び出し側が
 * `loading: true` のままスタックする（従業員マスターが「読み込み中」で開かない
 * 不具合の正体）。また postgrest-js はネットワーク例外を reject ではなく
 * `{ error }` として resolve するため、両経路を面倒みる必要がある。
 *
 * fetchWithRetry は
 *   1. 各試行に タイムアウト（既定10秒）を課す
 *   2. タイムアウト／reject／一時的エラー（Failed to fetch 等）は
 *      指数バックオフで再試行（既定2回）
 *   3. RLS 拒否などの恒久エラーは再試行せずそのまま返す
 */

export class QueryTimeoutError extends Error {
  constructor(ms: number) {
    super(`サーバーからの応答がありません（${Math.round(ms / 1000)}秒）`);
    this.name = "QueryTimeoutError";
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;

/** 再試行して良い一時的エラーか（ネットワーク断・fetch失敗・タイムアウト系）。 */
export function isTransientErrorMessage(message: string | undefined | null): boolean {
  if (!message) return false;
  return /failed to fetch|network|fetch failed|load failed|timed? ?out|socket|ECONN|abort/i.test(
    message,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(p),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new QueryTimeoutError(ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type SupabaseishResult = { error: { message: string } | null };

/**
 * `run` は毎試行呼ばれ、新しいクエリ（thenable）を作って返すこと。
 * PostgrestBuilder は単発使い捨てなので、同一 builder の再 await はしない。
 */
export async function fetchWithRetry<T extends SupabaseishResult>(
  run: () => PromiseLike<T>,
  opts: { timeoutMs?: number; retries?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  let lastRejection: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(400 * 2 ** (attempt - 1));
    try {
      const res = await withTimeout(run(), timeoutMs);
      // 一時的エラーは resolve 側にも来る（postgrest-js の仕様）。
      if (res.error && isTransientErrorMessage(res.error.message) && attempt < retries) {
        lastRejection = new Error(res.error.message);
        continue;
      }
      return res;
    } catch (e) {
      lastRejection = e;
      // タイムアウト／reject は次の試行へ
    }
  }
  throw lastRejection instanceof Error
    ? lastRejection
    : new Error("サーバーとの通信に失敗しました");
}
