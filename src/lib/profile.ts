import { supabase } from "./supabase";

/**
 * P1: 従業員プロフィール（カルチャー層／人事機密層）＋権限基盤の型と
 * 写真 signed URL ヘルパー。テーブル定義は
 * supabase/migrations/0015_profiles_and_permissions.sql を参照。
 */

/** 本人が自由追加できる項目（カルチャー層 custom_items / 機密層 items 共通）。 */
export type CustomItem = {
  id: string;
  label: string;
  value: string;
};

/** photos jsonb の1要素。path は profile-photos バケット内のパス。 */
export type PhotoItem = {
  path: string;
  caption?: string;
};

/** public.employee_profiles（カルチャー層・1人1行）。 */
export type ProfileRow = {
  employee_number: string;
  nickname: string | null;
  specialty: string | null;
  bio: string | null;
  hobbies: string | null;
  mbti: string | null;
  /** ストレングスファインダー上位5（text[] 相当の jsonb）。 */
  strengths: string[];
  custom_items: CustomItem[];
  photos: PhotoItem[];
  avatar_path: string | null;
  updated_at: string;
  updated_by_email: string | null;
};

/** public.employee_confidential（人事機密層・1人1行）。 */
export type ConfidentialRow = {
  employee_number: string;
  items: CustomItem[];
  updated_at: string;
  updated_by_email: string | null;
};

/** public.position_levels（役職→レベルの正規化辞書）。 */
export type PositionLevelRow = {
  position_title: string;
  level: number;
  label: string | null;
  sort_order: number;
};

/** public.module_permissions（モジュール×操作の必要レベル）。 */
export type ModulePermissionRow = {
  module: string;
  action: string;
  min_level: number;
};

/** public.permission_grants（役職レベルに依らない個別付与）。 */
export type PermissionGrantRow = {
  email: string;
  module: string;
  action: string;
  granted_by_email: string | null;
  created_at: string;
};

/** 権限管理画面などで使うモジュール／操作の日本語ラベル。 */
export const MODULE_LABEL: Record<string, string> = {
  profiles: "プロフィール",
  payroll: "給与・査定",
  survey: "サーベイ",
  mission: "ミッションシート",
};

export const ACTION_LABEL: Record<string, string> = {
  view_confidential: "機密情報の閲覧",
  edit_any: "他人プロフィール編集",
  view: "閲覧",
  edit: "編集",
  view_realname: "実名閲覧",
  manage_alerts: "アラート管理",
  manage: "管理（テンプレ・発行・査定）",
  evaluate_any: "全員の評価者として記入",
};

/** 表示用のアバターパス。avatar_path 未設定なら最初の写真にフォールバック
 *  する（写真をアップしたがアバター指定していない人もサムネが出るように）。 */
export function avatarPathOf(
  profile: Pick<ProfileRow, "avatar_path" | "photos"> | null | undefined,
): string | null {
  if (!profile) return null;
  return profile.avatar_path ?? profile.photos?.[0]?.path ?? null;
}

/** 役職名 → レベル。辞書に無い役職は 0 扱い（SQL 側 current_position_level と同じ規則）。 */
export function levelForPositionTitle(
  positionTitle: string | null | undefined,
  levels: PositionLevelRow[],
): number {
  if (!positionTitle) return 0;
  return levels.find((l) => l.position_title === positionTitle)?.level ?? 0;
}

const BUCKET = "profile-photos";
export const SIGNED_URL_TTL_SEC = 3600; // 1時間

/** 写真1枚の signed URL を取得。失敗時は null。 */
export async function signedPhotoUrl(path: string): Promise<string | null> {
  if (!supabase || !path) return null;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SEC);
  if (error || !data) return null;
  return data.signedUrl;
}

/** 複数パスの signed URL を一括取得（path → URL のマップを返す）。 */
export async function signedPhotoUrls(
  paths: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!supabase || paths.length === 0) return out;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrls(paths, SIGNED_URL_TTL_SEC);
  if (error || !data) return out;
  for (const item of data) {
    if (item.signedUrl && item.path) out[item.path] = item.signedUrl;
  }
  return out;
}

/** profile-photos バケットへのアップロード先パスを組み立てる。
 *  先頭セグメント＝社員番号が RLS の本人チェックに使われる。 */
export function buildPhotoPath(employeeNumber: string, fileName: string): string {
  const safe = fileName.replace(/[^\w.-]+/g, "_").slice(-80) || "photo";
  return `${employeeNumber}/${Date.now()}_${safe}`;
}

export const PROFILE_PHOTOS_BUCKET = BUCKET;
