import { useEffect, useMemo } from "react";
import {
  Network,
  Megaphone,
  Users,
  Target,
  Wallet,
  ShieldCheck,
  CloudSun,
  type LucideIcon,
} from "lucide-react";
import { useUiStore, type Route } from "../store/useUiStore";
import { useAuthStore } from "../store/useAuthStore";
import { useAnnouncementsStore } from "../store/useAnnouncementsStore";
import {
  canAccessPayroll,
  canManagePermissions,
  type AppUserRole,
} from "../lib/supabase";
import { formatPeriodHeading } from "../lib/announcement";

/**
 * TalentHub のトップページ（ホーム）。
 *
 * 以前は TOP=組織図だったが、機能が増える前提で「機能ハブ＋軽い
 * ダッシュボード」に分離した（組織図は #/org へ退避）。ここでは
 *   - 挨拶（名前・ロール）
 *   - 各機能へのカードナビ（権限でフィルタ）
 *   - 軽いウィジェット（最新の人事発令）
 * を出す。将来の機能（パルスサーベイ等）はカードを足すだけで拡張できる。
 */
type FeatureCard = {
  key: string;
  label: string;
  desc: string;
  Icon: LucideIcon;
  route: Route;
  /** 表示可否（未指定なら常時表示） */
  visible?: (role: AppUserRole | undefined) => boolean;
  /** 近日公開（クリック不可のプレースホルダ） */
  soon?: boolean;
};

const CARDS: FeatureCard[] = [
  {
    key: "org",
    label: "組織図",
    desc: "全社の配置・兼務・役割をツリー/一覧で確認・編集",
    Icon: Network,
    route: { name: "editor" },
  },
  {
    key: "announcements",
    label: "人事発令",
    desc: "月次の入社・退職・異動・任用の通知資料",
    Icon: Megaphone,
    route: { name: "announcements" },
  },
  {
    key: "employees",
    label: "メンバー",
    desc: "社員・インターンのプロフィールと在籍状況",
    Icon: Users,
    route: { name: "employees" },
  },
  {
    key: "missions",
    label: "ミッションシート",
    desc: "目標設定・中間/期末の記入と査定",
    Icon: Target,
    route: { name: "missions" },
  },
  {
    key: "salary",
    label: "給与・査定",
    desc: "給与表・等級マスター（権限者のみ）",
    Icon: Wallet,
    route: { name: "salary" },
    visible: (role) => canAccessPayroll(role),
  },
  {
    key: "permissions",
    label: "権限管理",
    desc: "ユーザーのロールとアクセス権（権限者のみ）",
    Icon: ShieldCheck,
    route: { name: "permissions" },
    visible: (role) => canManagePermissions(role),
  },
  {
    key: "pulse",
    label: "パルスサーベイ",
    desc: "今月のコンディションに回答（対象者）",
    Icon: CloudSun,
    route: { name: "survey" },
  },
];

export function HomePage() {
  const navigate = useUiStore((s) => s.navigate);
  const currentUser = useAuthStore((s) => s.currentUser);
  const annList = useAnnouncementsStore((s) => s.list);
  const refreshAnn = useAnnouncementsStore((s) => s.refresh);

  useEffect(() => {
    if (annList.length === 0) refreshAnn();
  }, [annList.length, refreshAnn]);

  const latestAnn = useMemo(() => {
    return (
      [...annList]
        .filter((a) => a.is_published)
        .sort((a, b) => b.period.localeCompare(a.period))[0] ?? null
    );
  }, [annList]);

  const role = currentUser?.role;
  const cards = CARDS.filter((c) => !c.visible || c.visible(role));
  const name = currentUser?.display_name ?? currentUser?.email ?? "ゲスト";

  return (
    <main className="page home">
      <section className="home__hero">
        <h1 className="home__hello">
          こんにちは、{name} さん
        </h1>
        <p className="home__sub">
          TalentHub — 組織・人事のハブ。使う機能を選んでください。
        </p>
      </section>

      {latestAnn && (
        <button
          className="home__widget"
          onClick={() => navigate({ name: "announcement", id: latestAnn.id })}
        >
          <span className="home__widgetIcon" aria-hidden>
            <Megaphone size={18} strokeWidth={2} />
          </span>
          <span className="home__widgetBody">
            <span className="home__widgetLabel">最新の人事発令</span>
            <span className="home__widgetTitle">
              {formatPeriodHeading(latestAnn.period)}　{latestAnn.title}
            </span>
          </span>
          <span className="home__widgetArrow" aria-hidden>→</span>
        </button>
      )}

      <div className="home__grid">
        {cards.map((c) => (
          <button
            key={c.key}
            className={`home__card ${c.soon ? "home__card--soon" : ""}`}
            disabled={c.soon}
            onClick={() => !c.soon && navigate(c.route)}
          >
            <span className="home__cardIcon" aria-hidden>
              <c.Icon size={22} strokeWidth={1.8} />
            </span>
            <span className="home__cardLabel">
              {c.label}
              {c.soon && <span className="home__badge">近日</span>}
            </span>
            <span className="home__cardDesc">{c.desc}</span>
          </button>
        ))}
      </div>
    </main>
  );
}
