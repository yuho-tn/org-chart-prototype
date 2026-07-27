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

/** SHO-SAN経歴の1行（career_rows jsonb・行形式自由入力／要件 7-1）。 */
export type CareerRow = {
  id: string;
  /** "YYYY-MM"。 */
  period_from: string;
  /** "YYYY-MM" または null（＝現在）。 */
  period_to: string | null;
  body: string;
};

/** public.employee_profiles（カルチャー層・1人1行）。 */
export type ProfileRow = {
  employee_number: string;
  nickname: string | null;
  /** @deprecated P3 で specialties(タグ複数)へ移行。データ温存のため列は残す。 */
  specialty: string | null;
  /** @deprecated P3 で blocks へ移行。データ温存のため列は残す。 */
  bio: string | null;
  /** @deprecated P3 で hobby_tags(タグ複数)へ移行。データ温存のため列は残す。 */
  hobbies: string | null;
  mbti: string | null;
  /** ストレングスファインダー：34資質から選んだ資質 id を順位順（配列順＝1〜5位）。 */
  strengths: string[];
  custom_items: CustomItem[];
  photos: PhotoItem[];
  avatar_path: string | null;
  // ── P3 追加（migration 0028） ──
  /** SHO-SAN経歴（行形式）。 */
  career_rows: CareerRow[];
  /** 得意領域タグ（複数）。 */
  specialties: string[];
  /** 趣味タグ（複数）。 */
  hobby_tags: string[];
  /** 自由プロフィール（ブロックエディタ・profileBlocks.ProfileBlock[] の生値）。 */
  blocks: unknown[];
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

/** ブロックエディタ画像のアップロード先パス（P3・要件 7-5）。
 *  ⚠ RLS は先頭セグメント＝社員番号を要求するため blocks/ は第2セグメントに置く
 *  （要件記載の `blocks/{num}/…` は RLS 違反になるため `{num}/blocks/…` に補正）。 */
export function buildBlockImagePath(employeeNumber: string, fileName: string): string {
  const safe = fileName.replace(/[^\w.-]+/g, "_").slice(-80) || "image";
  return `${employeeNumber}/blocks/${Date.now()}_${safe}`;
}

export const PROFILE_PHOTOS_BUCKET = BUCKET;
