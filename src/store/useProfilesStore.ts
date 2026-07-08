import { create } from "zustand";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import { useAuthStore, isManagerRole } from "./useAuthStore";
import { useEmployeesStore } from "./useEmployeesStore";
import {
  levelForPositionTitle,
  signedPhotoUrls,
  buildPhotoPath,
  PROFILE_PHOTOS_BUCKET,
  SIGNED_URL_TTL_SEC,
  type ProfileRow,
  type ConfidentialRow,
  type PositionLevelRow,
  type ModulePermissionRow,
  type PermissionGrantRow,
  type PhotoItem,
} from "../lib/profile";

/**
 * P1: プロフィール（カルチャー層／機密層）＋権限基盤のストア。
 *
 * 同期方針: プロフィールは低頻度データなので 20 秒ポーリングはしない。
 * 画面表示時の fetch ＋ フォーカス時再検証（各画面側の useEffect）で十分。
 *
 * 権限: can() はあくまで UI 表示制御用のクライアント側ミラー判定。
 * 真の強制は RLS（has_module_permission）が行う — RLS に拒否された upsert は
 * .select().maybeSingle() の 0 行として検出しエラー化する（useVersionsStore
 * の setConfirmation と同型のサイレント拒否対策）。
 */

type SaveResult = { ok: boolean; reason?: string };

type ProfilesState = {
  loaded: boolean;
  loading: boolean;
  error: string | null;

  /** employee_number → カルチャー層プロフィール。 */
  profilesByNumber: Record<string, ProfileRow>;
  /** employee_number → 機密層。権限がある時のみ fetch される。 */
  confidentialByNumber: Record<string, ConfidentialRow>;

  positionLevels: PositionLevelRow[];
  modulePermissions: ModulePermissionRow[];
  permissionGrants: PermissionGrantRow[];

  /** storage パス → signed URL のキャッシュ。TTL(1時間)の8割経過で
   *  ensurePhotoUrls が自動再発行する（期限切れURLの表示を防ぐ）。 */
  photoUrls: Record<string, string>;
  /** path → 発行時刻(ms)。photoUrls の鮮度判定用。 */
  photoUrlIssuedAt: Record<string, number>;

  /** プロフィール一覧＋権限マスター（levels / permissions / grants）をロード。 */
  refresh: () => Promise<void>;
  /** 機密層を1件 fetch。権限が無い場合（RLS 403 / 0行）は静かに無視。 */
  fetchConfidential: (employeeNumber: string) => Promise<void>;
  /** 未取得の signed URL をまとめて発行してキャッシュに足す。 */
  ensurePhotoUrls: (paths: string[]) => Promise<void>;

  /** UI 表示制御用のクライアント側権限ミラー判定（真の強制は RLS）。 */
  can: (module: string, action: string) => boolean;
  /** ログイン中ユーザーの employee_number（employees.email との一致で解決）。 */
  currentEmployeeNumber: () => string | null;

  saveProfile: (
    row: Partial<ProfileRow> & { employee_number: string },
  ) => Promise<SaveResult>;
  saveConfidential: (
    row: Partial<ConfidentialRow> & { employee_number: string },
  ) => Promise<SaveResult>;

  uploadPhoto: (
    employeeNumber: string,
    file: File,
    caption?: string,
  ) => Promise<SaveResult>;
  removePhoto: (employeeNumber: string, path: string) => Promise<SaveResult>;
  setAvatar: (employeeNumber: string, path: string | null) => Promise<SaveResult>;

  // ── 権限管理画面用（RLS: master/privileged_admin のみ書込み可） ──
  upsertPositionLevel: (
    row: Partial<PositionLevelRow> & { position_title: string },
  ) => Promise<SaveResult>;
  setModulePermissionLevel: (
    module: string,
    action: string,
    min_level: number,
  ) => Promise<SaveResult>;
  addGrant: (email: string, module: string, action: string) => Promise<SaveResult>;
  removeGrant: (email: string, module: string, action: string) => Promise<SaveResult>;
};

const RLS_DENIED_MSG =
  "保存がDBに反映されませんでした（権限が無い可能性があります）。";

/** jsonb カラムの取りうる null / 不正値を配列に正規化する。 */
function normalizeProfile(row: ProfileRow): ProfileRow {
  return {
    ...row,
    strengths: Array.isArray(row.strengths) ? row.strengths : [],
    custom_items: Array.isArray(row.custom_items) ? row.custom_items : [],
    photos: Array.isArray(row.photos) ? row.photos : [],
  };
}

export const useProfilesStore = create<ProfilesState>((set, get) => ({
  loaded: false,
  loading: false,
  error: null,
  profilesByNumber: {},
  confidentialByNumber: {},
  positionLevels: [],
  modulePermissions: [],
  permissionGrants: [],
  photoUrls: {},
  photoUrlIssuedAt: {},

  refresh: async () => {
    if (!isSupabaseConfigured || !supabase) {
      set({ loaded: true });
      return;
    }
    set({ loading: true, error: null });
    const [pRes, lRes, mRes, gRes] = await Promise.all([
      supabase.from("employee_profiles").select("*"),
      supabase.from("position_levels").select("*"),
      supabase.from("module_permissions").select("*"),
      supabase.from("permission_grants").select("*"),
    ]);
    if (pRes.error || lRes.error || mRes.error || gRes.error) {
      const err = pRes.error ?? lRes.error ?? mRes.error ?? gRes.error;
      const isMissing = err && /does not exist|could not find the table/i.test(err.message);
      set({
        loading: false,
        loaded: true,
        error: isMissing
          ? "プロフィールテーブルが見つかりません。supabase/migrations/0015_profiles_and_permissions.sql を適用してください。"
          : err?.message ?? "プロフィールの取得に失敗しました",
      });
      return;
    }
    const byNumber: Record<string, ProfileRow> = {};
    for (const row of (pRes.data ?? []) as ProfileRow[]) {
      byNumber[row.employee_number] = normalizeProfile(row);
    }
    set({
      loading: false,
      loaded: true,
      error: null,
      profilesByNumber: byNumber,
      positionLevels: ((lRes.data ?? []) as PositionLevelRow[]).sort(
        (a, b) => b.level - a.level || a.position_title.localeCompare(b.position_title, "ja"),
      ),
      modulePermissions: (mRes.data ?? []) as ModulePermissionRow[],
      permissionGrants: (gRes.data ?? []) as PermissionGrantRow[],
    });
  },

  fetchConfidential: async (employeeNumber) => {
    if (!supabase) return;
    // RLS 拒否は error（permission denied）または 0 行として返る — どちらも
    // 「見せない」だけなので静かに無視する。
    const { data, error } = await supabase
      .from("employee_confidential")
      .select("*")
      .eq("employee_number", employeeNumber)
      .maybeSingle();
    if (error || !data) return;
    const row = data as ConfidentialRow;
    set((s) => ({
      confidentialByNumber: {
        ...s.confidentialByNumber,
        [employeeNumber]: {
          ...row,
          items: Array.isArray(row.items) ? row.items : [],
        },
      },
    }));
  },

  ensurePhotoUrls: async (paths) => {
    const { photoUrls, photoUrlIssuedAt } = get();
    const now = Date.now();
    // TTL の8割を過ぎた URL は失効前に再発行する
    const refreshAfterMs = SIGNED_URL_TTL_SEC * 1000 * 0.8;
    const isStale = (p: string) =>
      !photoUrls[p] || now - (photoUrlIssuedAt[p] ?? 0) > refreshAfterMs;
    const missing = [...new Set(paths.filter((p) => p && isStale(p)))];
    if (missing.length === 0) return;
    const urls = await signedPhotoUrls(missing);
    if (Object.keys(urls).length === 0) return;
    const issued: Record<string, number> = {};
    for (const p of Object.keys(urls)) issued[p] = now;
    set((s) => ({
      photoUrls: { ...s.photoUrls, ...urls },
      photoUrlIssuedAt: { ...s.photoUrlIssuedAt, ...issued },
    }));
  },

  can: (module, action) => {
    const user = useAuthStore.getState().currentUser;
    if (!user) return false;
    // アプリ管理ロール（master/privileged_admin）は常に許可 — SQL の
    // has_module_permission と同じバイパス。
    if (user.role === "master" || user.role === "privileged_admin") return true;
    // 個別付与
    if (
      get().permissionGrants.some(
        (g) => g.email === user.email && g.module === module && g.action === action,
      )
    ) {
      return true;
    }
    // 役職レベル判定（自分の employees 行 → position_levels）
    const required = get().modulePermissions.find(
      (m) => m.module === module && m.action === action,
    )?.min_level;
    if (required == null) return false;
    const me = useEmployeesStore
      .getState()
      .employees.find((e) => e.email?.toLowerCase() === user.email);
    const myLevel = levelForPositionTitle(me?.position_title, get().positionLevels);
    return myLevel >= required;
  },

  currentEmployeeNumber: () => {
    const email = useAuthStore.getState().currentUser?.email;
    if (!email) return null;
    const me = useEmployeesStore
      .getState()
      .employees.find((e) => e.email?.toLowerCase() === email);
    return me?.employee_number ?? null;
  },

  saveProfile: async (row) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const sessionEmail = useAuthStore.getState().currentUser?.email ?? null;
    const { data, error } = await supabase
      .from("employee_profiles")
      .upsert(
        { ...row, updated_by_email: sessionEmail },
        { onConflict: "employee_number" },
      )
      .select("*")
      .maybeSingle();
    if (error) return { ok: false, reason: error.message };
    // 0行 = RLSサイレント拒否（useVersionsStore.setConfirmation と同型の対策）
    if (!data) return { ok: false, reason: RLS_DENIED_MSG };
    const saved = normalizeProfile(data as ProfileRow);
    set((s) => ({
      profilesByNumber: { ...s.profilesByNumber, [saved.employee_number]: saved },
    }));
    return { ok: true };
  },

  saveConfidential: async (row) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const sessionEmail = useAuthStore.getState().currentUser?.email ?? null;
    const { data, error } = await supabase
      .from("employee_confidential")
      .upsert(
        { ...row, updated_by_email: sessionEmail },
        { onConflict: "employee_number" },
      )
      .select("*")
      .maybeSingle();
    if (error) return { ok: false, reason: error.message };
    if (!data) return { ok: false, reason: RLS_DENIED_MSG };
    const saved = data as ConfidentialRow;
    set((s) => ({
      confidentialByNumber: {
        ...s.confidentialByNumber,
        [saved.employee_number]: {
          ...saved,
          items: Array.isArray(saved.items) ? saved.items : [],
        },
      },
    }));
    return { ok: true };
  },

  uploadPhoto: async (employeeNumber, file, caption) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const path = buildPhotoPath(employeeNumber, file.name);
    const { error: upErr } = await supabase.storage
      .from(PROFILE_PHOTOS_BUCKET)
      .upload(path, file, { contentType: file.type || undefined });
    if (upErr) return { ok: false, reason: upErr.message };
    const current = get().profilesByNumber[employeeNumber];
    const photos: PhotoItem[] = [
      ...(current?.photos ?? []),
      caption ? { path, caption } : { path },
    ];
    // アバター未設定なら最初にアップした写真を自動でアバターにする
    // （顔写真をアップしたのにギャラリーのサムネに出ない、を防ぐ）。
    const patch: Partial<ProfileRow> & { employee_number: string } = {
      employee_number: employeeNumber,
      photos,
    };
    if (!current?.avatar_path) patch.avatar_path = path;
    const res = await get().saveProfile(patch);
    if (!res.ok) {
      // jsonb 更新に失敗したら storage 側の孤児ファイルを掃除しておく
      await supabase.storage.from(PROFILE_PHOTOS_BUCKET).remove([path]);
      return res;
    }
    await get().ensurePhotoUrls([path]);
    return { ok: true };
  },

  removePhoto: async (employeeNumber, path) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const current = get().profilesByNumber[employeeNumber];
    const photos = (current?.photos ?? []).filter((p) => p.path !== path);
    const patch: Partial<ProfileRow> & { employee_number: string } = {
      employee_number: employeeNumber,
      photos,
    };
    // 削除した写真がアバターだった場合は解除する
    if (current?.avatar_path === path) patch.avatar_path = null;
    const res = await get().saveProfile(patch);
    if (!res.ok) return res;
    await supabase.storage.from(PROFILE_PHOTOS_BUCKET).remove([path]);
    return { ok: true };
  },

  setAvatar: async (employeeNumber, path) => {
    return get().saveProfile({ employee_number: employeeNumber, avatar_path: path });
  },

  upsertPositionLevel: async (row) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const { data, error } = await supabase
      .from("position_levels")
      .upsert(row, { onConflict: "position_title" })
      .select("*")
      .maybeSingle();
    if (error) return { ok: false, reason: error.message };
    if (!data) return { ok: false, reason: RLS_DENIED_MSG };
    const saved = data as PositionLevelRow;
    set((s) => {
      const rest = s.positionLevels.filter(
        (l) => l.position_title !== saved.position_title,
      );
      return {
        positionLevels: [...rest, saved].sort(
          (a, b) =>
            b.level - a.level || a.position_title.localeCompare(b.position_title, "ja"),
        ),
      };
    });
    return { ok: true };
  },

  setModulePermissionLevel: async (module, action, min_level) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const { data, error } = await supabase
      .from("module_permissions")
      .upsert({ module, action, min_level }, { onConflict: "module,action" })
      .select("*")
      .maybeSingle();
    if (error) return { ok: false, reason: error.message };
    if (!data) return { ok: false, reason: RLS_DENIED_MSG };
    set((s) => ({
      modulePermissions: s.modulePermissions.map((m) =>
        m.module === module && m.action === action ? { ...m, min_level } : m,
      ),
    }));
    return { ok: true };
  },

  addGrant: async (email, module, action) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const norm = email.trim().toLowerCase();
    if (!norm.includes("@")) return { ok: false, reason: "メールアドレスの形式が不正です" };
    const sessionEmail = useAuthStore.getState().currentUser?.email ?? null;
    const { data, error } = await supabase
      .from("permission_grants")
      .upsert(
        { email: norm, module, action, granted_by_email: sessionEmail },
        { onConflict: "email,module,action" },
      )
      .select("*")
      .maybeSingle();
    if (error) return { ok: false, reason: error.message };
    if (!data) return { ok: false, reason: RLS_DENIED_MSG };
    const saved = data as PermissionGrantRow;
    set((s) => ({
      permissionGrants: [
        ...s.permissionGrants.filter(
          (g) => !(g.email === norm && g.module === module && g.action === action),
        ),
        saved,
      ],
    }));
    return { ok: true };
  },

  removeGrant: async (email, module, action) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const { error } = await supabase
      .from("permission_grants")
      .delete()
      .eq("email", email)
      .eq("module", module)
      .eq("action", action);
    if (error) return { ok: false, reason: error.message };
    set((s) => ({
      permissionGrants: s.permissionGrants.filter(
        (g) => !(g.email === email && g.module === module && g.action === action),
      ),
    }));
    return { ok: true };
  },
}));

/**
 * プロフィール編集可否のクライアント側ミラー（RLS と同一規則）:
 * 本人 OR edit_any 権限 OR is_manager(master/admin)。
 * master/privileged_admin は can() 内で常に true になる。
 */
export function canEditProfileOf(employeeNumber: string): boolean {
  const st = useProfilesStore.getState();
  if (st.currentEmployeeNumber() === employeeNumber) return true;
  if (st.can("profiles", "edit_any")) return true;
  return isManagerRole(useAuthStore.getState().currentUser?.role);
}
