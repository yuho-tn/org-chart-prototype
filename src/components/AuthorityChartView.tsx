import { useMemo } from "react";
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
 * CEO / 役員 / DM / TM の4レイヤーに横軸を揃えて並べる（2026-08-05 MTG合意）。
 *
 * 体制図（誰がどこに所属しているか）とは目的が違い、この画面が答えるのは
 * 「この組織の決裁は誰に上げればいいのか」1点。チャレンジ任用しかいない組織は
 * 上位から繰り上げた実質マネージャーを主役に置き、実務担当のチャレンジ本人は
 * 併記に回す。
 */

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
      {person.isConcurrent && <span className="authchip__flag">兼務</span>}
    </div>
  );
}

function UnitCard({ unit }: { unit: AuthorityUnit }) {
  return (
    <div className={`authcard authcard--${unit.layer}`}>
      <div className="authcard__head">
        <span className="authcard__name">{unit.name}</span>
        {unit.parentName && (
          <span className="authcard__parent">{unit.parentName}</span>
        )}
      </div>
      {/* 繰り上げの理由を先に読ませてから名前を出す（「なぜこの人？」を残さない） */}
      {unit.ownerIsActing && (
        <div className="authcard__acting">
          実質マネージャー
          {unit.ownerFrom ? `（${unit.ownerFrom}から繰り上げ）` : ""}
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

function CompanyBlock({
  company,
  isAffiliate,
}: {
  company: AuthorityCompany;
  isAffiliate: boolean;
}) {
  const cols = company.columns;
  const hasDiv = cols.some((c) => c.divs.length > 0);
  const hasTm = cols.some((c) => c.tms.length > 0);
  // 列幅は中身の多さに比例させる。事業統括だけTMが7つあるので等幅にすると
  // その列だけ縦に伸びて「横軸を揃える」意図が壊れる。広い列はセル内が
  // 自動で2カラムに折り返す（.authgrid__cell の auto-fill）。
  const weights = cols.map((c) =>
    Math.min(3, Math.max(1, Math.ceil(Math.max(c.divs.length, c.tms.length) / 3))),
  );
  const gridStyle = {
    gridTemplateColumns: `var(--authlayer-w) ${weights
      .map((w) => `minmax(210px, ${w}fr)`)
      .join(" ")}`,
  };

  // 部署ノードを持たない法人（（株）ハウジングナビ等）はレイヤーグリッドが
  // 成立しないので、役職者を並べただけの簡易表示にする。
  if (cols.length === 0) {
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

      {/* 列見出し（系統） */}
      <div className="authgrid" style={gridStyle}>
        <div className="authgrid__corner" />
        {cols.map((c) => (
          <div key={c.id} className="authgrid__colhead">
            {c.name}
          </div>
        ))}

        {/* CEO 帯：全列ぶち抜き */}
        <div className="authgrid__layer">
          <div className="authgrid__layerInner">
            <span className="authgrid__layerName">{LAYER_LABEL.ceo}</span>
            <span className="authgrid__layerNote">{LAYER_NOTE.ceo}</span>
          </div>
        </div>
        <div
          className="authgrid__cell authgrid__cell--span"
          style={{ gridColumn: `2 / span ${cols.length}` }}
        >
          {company.ceo.length ? (
            company.ceo.map((p) => (
              <div key={p.nodeId} className="authcard authcard--ceo">
                <PersonChip person={p} variant="owner" prefix="決裁" />
              </div>
            ))
          ) : (
            <div className="authcard__empty">CEOが未設定</div>
          )}
        </div>

        {/* 役員 */}
        <div className="authgrid__layer">
          <div className="authgrid__layerInner">
            <span className="authgrid__layerName">{LAYER_LABEL.exec}</span>
            <span className="authgrid__layerNote">{LAYER_NOTE.exec}</span>
          </div>
        </div>
        {cols.map((c) => (
          <div key={c.id} className="authgrid__cell">
            {c.exec ? (
              <UnitCard unit={c.exec} />
            ) : (
              <div className="authgrid__direct">
                CEOが直接管掌
                <span>この列の組織は役員レイヤーを経由しません</span>
              </div>
            )}
          </div>
        ))}

        {/* DM */}
        {hasDiv && (
          <>
            <div className="authgrid__layer">
              <div className="authgrid__layerInner">
                <span className="authgrid__layerName">{LAYER_LABEL.div}</span>
                <span className="authgrid__layerNote">{LAYER_NOTE.div}</span>
              </div>
            </div>
            {cols.map((c) => (
              <div key={c.id} className="authgrid__cell">
                {c.divs.length ? (
                  c.divs.map((u) => <UnitCard key={u.id} unit={u} />)
                ) : (
                  <div className="authgrid__none">—</div>
                )}
              </div>
            ))}
          </>
        )}

        {/* TM */}
        {hasTm && (
          <>
            <div className="authgrid__layer">
              <div className="authgrid__layerInner">
                <span className="authgrid__layerName">{LAYER_LABEL.tm}</span>
                <span className="authgrid__layerNote">{LAYER_NOTE.tm}</span>
              </div>
            </div>
            {cols.map((c) => (
              <div key={c.id} className="authgrid__cell">
                {c.tms.length ? (
                  c.tms.map((u) => <UnitCard key={u.id} unit={u} />)
                ) : (
                  <div className="authgrid__none">—</div>
                )}
              </div>
            ))}
          </>
        )}
      </div>

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
            4レイヤーで横軸を揃えて表示しています（メンバーの所属は「体制図」タブ）。
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
          実質マネージャー＝チャレンジ任用のため上位から繰り上げ
        </span>
        <span className="authlegend authlegend--challenge">
          担当＝チャレンジ任用で実務を回している本人（決裁権なし）
        </span>
      </div>

      <CompanyBlock company={chart.main} isAffiliate={false} />
      {chart.affiliates.map((c) => (
        <CompanyBlock key={c.id} company={c} isAffiliate />
      ))}

      <p className="authview__foot">
        この図は体制図と同じデータから自動生成されます。人事発令で体制図を更新すれば、
        権限図も同時に更新されます。金額上限や承認の段数は「ML規定」タブを参照してください。
      </p>
    </div>
  );
}
