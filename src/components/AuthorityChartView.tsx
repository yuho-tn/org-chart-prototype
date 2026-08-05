import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import {
  buildAuthorityChart,
  countManagers,
  LAYER_LABEL,
  LAYER_NOTE,
  type AuthorityCompany,
  type AuthorityPerson,
  type AuthorityUnit,
} from "../lib/authority";

/**
 * 「組織図」タブ＝権限図。体制図と同じデータから、マネージャー以上だけを
 * CEO / 役員 / DM / TM の4レイヤーのピラミッドツリーで表示する。
 *
 * 体制図（誰がどこに所属しているか）とは目的が違い、この画面が答えるのは
 * 「この組織の決裁は誰に上げればいいのか」1点。チャレンジ任用しかいない組織は
 * 上位から繰り上げた実質マネージャーを主役に置き、実務担当のチャレンジ本人は
 * 併記に回す。
 *
 * ── レイアウト方針（2026-08-05 裕鵬さん指示） ──────────────────
 * ツリー形式にしつつ「役職ごとに縦の行を揃える」。入れ子のCSSツリーだと
 * HR TM（役員直下のTM＝DM層を飛ばす枝）が DM行に来てしまうので採らない。
 * 代わりに **レイヤー＝grid行 / 葉の数＝grid列** とし、各ノードを
 * 「自分のサブツリーが占める列範囲」に置く（colStart/colSpan は
 * lib/authority.ts が算出）。これで親は必ず子の真ん中に乗り、行は揃う。
 * 親子の線は配置後の実DOM位置を測ってSVGで引く。
 */

type Edge = { key: string; x1: number; y1: number; x2: number; y2: number; midY: number };

function PersonChip({
  person,
  variant,
  prefix,
}: {
  person: AuthorityPerson;
  variant: "owner" | "challenge" | "exec";
  prefix?: string;
}) {
  return (
    <div className={`authchip authchip--${variant}`}>
      {prefix && <span className="authchip__prefix">{prefix}</span>}
      <span className="authchip__name">{person.name}</span>
      <span className="authchip__role" title={person.roleDescription}>
        {person.role}
      </span>
      {person.isConcurrent && (
        <span className="authchip__flag" title="兼務">兼</span>
      )}
    </div>
  );
}

function UnitCard({ unit }: { unit: AuthorityUnit }) {
  return (
    <div className={`authcard authcard--${unit.layer}`}>
      <div className="authcard__head">
        <span className="authcard__name">{unit.name}</span>
      </div>
      {/* 繰り上げの理由を先に読ませてから名前を出す（「なぜこの人？」を残さない） */}
      {unit.ownerIsActing && (
        <div className="authcard__acting">
          実質{unit.ownerFrom ? `（${unit.ownerFrom}から）` : ""}
        </div>
      )}
      {unit.owner ? (
        <PersonChip person={unit.owner} variant="owner" prefix="決裁" />
      ) : (
        <div className="authcard__empty">権限者が未設定</div>
      )}
      {unit.challengers.map((p) => (
        <PersonChip key={p.nodeId} person={p} variant="challenge" prefix="担当" />
      ))}
      {unit.executives.map((p) => (
        <PersonChip key={p.nodeId} person={p} variant="exec" prefix="役員" />
      ))}
    </div>
  );
}

function CompanyTree({
  company,
  isAffiliate,
}: {
  company: AuthorityCompany;
  isAffiliate: boolean;
}) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef(new Map<string, HTMLDivElement>());
  const [edges, setEdges] = useState<Edge[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });

  const setNodeRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) nodeRefs.current.set(id, el);
    else nodeRefs.current.delete(id);
  }, []);

  const units = useMemo(
    () => company.layers.flatMap((r) => r.units),
    [company.layers],
  );

  /** 配置後の実DOM位置から親子の接続線を作る。 */
  const measure = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const base = grid.getBoundingClientRect();
    const next: Edge[] = [];
    for (const u of units) {
      if (!u.parentUnitId) continue;
      const childEl = nodeRefs.current.get(u.id);
      const parentEl = nodeRefs.current.get(u.parentUnitId);
      if (!childEl || !parentEl) continue;
      const c = childEl.getBoundingClientRect();
      const p = parentEl.getBoundingClientRect();
      const x1 = p.left - base.left + p.width / 2;
      const y1 = p.bottom - base.top;
      const x2 = c.left - base.left + c.width / 2;
      const y2 = c.top - base.top;
      // 行間(row-gap 44px)の中央を共通バスにする。親が同じ枝は必ず同じ高さで
      // 横に走るので、レイヤーを飛ばす枝（HR TM 等）があっても図が乱れない。
      next.push({ key: `${u.parentUnitId}->${u.id}`, x1, y1, x2, y2, midY: y1 + 22 });
    }
    setEdges(next);
    setSize({ w: grid.scrollWidth, h: grid.scrollHeight });
  }, [units]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(grid);
    for (const el of nodeRefs.current.values()) ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  // 部署ノードを持たない法人（（株）ハウジングナビ等）はツリーが成立しないので、
  // 役職者を並べただけの簡易表示にする。
  const hasTree = company.layers.some((r) => r.layer !== "ceo");
  if (!hasTree) {
    const people = [...company.ceo, ...company.rootOfficers];
    return (
      <section className={`authco authco--flat ${isAffiliate ? "authco--affiliate" : ""}`}>
        <h2 className="authco__title">
          {isAffiliate && <span className="authco__tag">関連会社</span>}
          {company.name}
        </h2>
        <div className="authco__officers">
          <span className="authco__officersLabel">役職者</span>
          {people.length ? (
            people.map((p) => (
              <PersonChip key={p.nodeId} person={p} variant="owner" prefix="決裁" />
            ))
          ) : (
            <span className="authcard__empty">役職者が登録されていません</span>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className={`authco ${isAffiliate ? "authco--affiliate" : ""}`}>
      <h2 className="authco__title">
        {isAffiliate && <span className="authco__tag">関連会社</span>}
        {company.name}
      </h2>

      <div className="authtree">
        <div className="authtree__scroll">
          {/* レイヤー名レーンとツリー本体は「同じ1つのgrid」に置く。
           * 別gridで横並びにすると行トラックの高さが一致せず、
           * 区分の帯とブロックが微妙にズレる（2026-08-06 FB）。
           * レーンは column 1 に置き、横スクロール中も見えるよう sticky。 */}
          <div
            className="authtree__grid"
            ref={gridRef}
            style={{
              gridTemplateColumns: `var(--authlayer-w) repeat(${company.totalCols}, minmax(162px, 1fr))`,
              gridTemplateRows: `repeat(${company.layers.length}, auto)`,
            }}
          >
            <svg
              className="authtree__wires"
              width={size.w || undefined}
              height={size.h || undefined}
              aria-hidden
            >
              {edges.map((e) => (
                <path
                  key={e.key}
                  d={`M ${e.x1} ${e.y1} V ${e.midY} H ${e.x2} V ${e.y2}`}
                  fill="none"
                />
              ))}
            </svg>

            {company.layers.map((row, rowIndex) => (
              <div
                key={`lane-${row.layer}`}
                className="authtree__lane"
                style={{ gridRow: rowIndex + 1, gridColumn: 1 }}
              >
                <span className="authtree__laneName">{LAYER_LABEL[row.layer]}</span>
                <span className="authtree__laneNote">{LAYER_NOTE[row.layer]}</span>
              </div>
            ))}

            {company.layers.map((row, rowIndex) =>
              row.units.map((u) => (
                <div
                  key={u.id}
                  className="authtree__slot"
                  style={{
                    gridRow: rowIndex + 1,
                    // 1列目はレイヤー名レーンなので +1 する
                    gridColumn: `${u.colStart + 1} / span ${u.colSpan}`,
                  }}
                >
                  <div className="authtree__node" ref={(el) => setNodeRef(u.id, el)}>
                    <UnitCard unit={u} />
                  </div>
                </div>
              )),
            )}
          </div>
        </div>
      </div>
      <p className="authtree__hint">
        枝が多い期は横に長くなります。図の中を左右にスクロールしてご覧ください。
      </p>

      {company.rootOfficers.length > 0 && (
        <div className="authco__officers">
          <span className="authco__officersLabel">法人直下の役職者</span>
          {company.rootOfficers.map((p) => (
            <PersonChip key={p.nodeId} person={p} variant="owner" />
          ))}
        </div>
      )}

      {company.attachedExecutives.length > 0 && (
        <div className="authco__officers">
          <span className="authco__officersLabel">部門付き役員</span>
          {company.attachedExecutives.map(({ person, unitName }) => (
            <PersonChip
              key={person.nodeId}
              person={person}
              variant="exec"
              prefix={unitName}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function AuthorityChartView() {
  const nodes = useOrgStore((s) => s.nodes);
  const chart = useMemo(() => buildAuthorityChart(nodes), [nodes]);
  const managers = useMemo(() => countManagers(chart), [chart]);

  if (!chart.main) {
    return (
      <div className="authview">
        <div className="authview__empty">
          組織図ファイルが読み込まれていません。左上の「ファイル」から開いてください。
        </div>
      </div>
    );
  }

  return (
    <div className="authview">
      <header className="authview__head">
        <div>
          <h1 className="authview__title">組織図（権限図）</h1>
          <p className="authview__lead">
            決裁・承認を誰に上げるかを示す図です。マネージャー以上のみを、CEO／役員／DM／TMの
            4レイヤーで行を揃えたツリーで表示しています（メンバーの所属は「体制図」タブ）。
          </p>
        </div>
        <div className="authview__count">
          <strong>{managers}</strong>
          <span>マネージャー以上</span>
        </div>
      </header>

      <div className="authview__legend">
        <span className="authlegend authlegend--owner">決裁＝決裁権を持つ人</span>
        <span className="authlegend authlegend--acting">
          実質＝チャレンジ任用のため上位から繰り上げ
        </span>
        <span className="authlegend authlegend--challenge">
          担当＝チャレンジ任用で実務を回している本人（決裁権なし）
        </span>
      </div>

      <CompanyTree company={chart.main} isAffiliate={false} />
      {chart.affiliates.map((c) => (
        <CompanyTree key={c.id} company={c} isAffiliate />
      ))}

      <p className="authview__foot">
        この図は体制図と同じデータから自動生成されます。人事発令で体制図を更新すれば、
        権限図も同時に更新されます。金額上限や承認の段数は「ML規定」タブを参照してください。
      </p>
    </div>
  );
}
