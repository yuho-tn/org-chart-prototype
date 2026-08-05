import {
  ML_CHALLENGE_NOTE,
  ML_EVALUATOR_ROWS,
  ML_LEGEND,
  ML_ROLES,
  ML_SECTIONS,
  ML_SOURCE_URL,
  type MlCell,
} from "../lib/mlRules";

/**
 * 「ML規定」タブ。Notion のML規定表を TalentHub 内に持ち込んだもの。
 * 権限図（組織図タブ）で「誰に上げるか」が分かった次に、「何をどこまで決めていいのか」を
 * 答える面。2026-08-05 MTGで「表はあるが多くの人が見ていない」課題への対応。
 */

function Cell({ cell }: { cell: MlCell }) {
  const tone = cell.tone ?? "has";
  return (
    <td className={`mltable__cell mltable__cell--${tone}`}>
      <span className="mltable__text">
        {cell.text}
        {cell.supplemented && (
          <span className="mltable__mark" title="原表では空欄。運用実態に合わせて補完">
            ★
          </span>
        )}
      </span>
      {cell.note && <span className="mltable__note">{cell.note}</span>}
    </td>
  );
}

export function MlRulesView() {
  return (
    <div className="mlview">
      <header className="mlview__head">
        <h1 className="mlview__title">ML規定（マネージャー・リーダー規定）</h1>
        <p className="mlview__lead">
          役職ごとに「何をどこまで決めていいか」を定めた規定です。自分の役職の列を縦に読めば、
          持っている権限が一覧できます。決裁を誰に上げるかは「組織図」タブを参照してください。
        </p>
      </header>

      <div className="mlview__callout">{ML_CHALLENGE_NOTE}</div>

      {ML_SECTIONS.map((sec) => (
        <section key={sec.id} className="mlsec">
          <h2 className="mlsec__title">{sec.title}</h2>
          <p className="mlsec__desc">{sec.description}</p>
          <div className="mltable__scroll">
            <table className="mltable">
              <thead>
                <tr>
                  <th className="mltable__rowhead">項目</th>
                  {ML_ROLES.map((r) => (
                    <th key={r.code} className="mltable__colhead">
                      <span className="mltable__code">{r.code}</span>
                      <span className="mltable__rolename">{r.name}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sec.rows.map((row) => (
                  <tr key={row.label}>
                    <th className="mltable__rowhead" scope="row">
                      {row.label}
                      {row.sublabel && (
                        <span className="mltable__sublabel">{row.sublabel}</span>
                      )}
                    </th>
                    {row.cells.map((c, i) => (
                      <Cell key={ML_ROLES[i].code} cell={c} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <section className="mlsec">
        <h2 className="mlsec__title">評価者（ミッション面談）</h2>
        <p className="mlsec__desc">
          評価は必ず一次・二次の2段。自分が評価される側としてどの行に当たるかを見る。
        </p>
        <div className="mltable__scroll">
          <table className="mltable mltable--eval">
            <thead>
              <tr>
                <th className="mltable__rowhead">被評価者</th>
                <th className="mltable__colhead">一次評価者</th>
                <th className="mltable__colhead">二次評価者</th>
                <th className="mltable__colhead">補足</th>
              </tr>
            </thead>
            <tbody>
              {ML_EVALUATOR_ROWS.map((r) => (
                <tr key={r.target}>
                  <th className="mltable__rowhead" scope="row">
                    {r.target}
                  </th>
                  <td className="mltable__cell mltable__cell--has">
                    <span className="mltable__text">{r.first}</span>
                  </td>
                  <td
                    className={`mltable__cell mltable__cell--${r.second === "—" ? "none" : "has"}`}
                  >
                    <span className="mltable__text">{r.second}</span>
                  </td>
                  <td className="mltable__cell mltable__cell--has">
                    <span className="mltable__note">{r.note ?? ""}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mlsec mlsec--legend">
        <h2 className="mlsec__title">凡例</h2>
        <dl className="mllegend">
          {ML_LEGEND.map((l) => (
            <div key={l.mark} className="mllegend__row">
              <dt>{l.mark}</dt>
              <dd>{l.meaning}</dd>
            </div>
          ))}
        </dl>
        <p className="mlview__foot">
          出典：Notion「ML規定」。制度改定時はNotionを正としてこのページを更新します。{" "}
          <a href={ML_SOURCE_URL} target="_blank" rel="noreferrer">
            Notionの原本を開く
          </a>
        </p>
      </section>
    </div>
  );
}
