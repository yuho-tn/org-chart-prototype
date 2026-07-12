-- 0035: ミッションシート P5① — 5期上期テンプレの seed（draft）
--
-- Googleシート「目標設計シート」の構造化マッピング（要件定義 §9①・2026-07-12
-- 裕鵬さん確定）。CREDO/6SENSE/VBCF の文言は #/reviews（src/lib/reviewsContent.ts
-- ＝人事評価制度 v2.2）から転記。給与欄（今期給与・基本給・固定残業）は非搭載
-- （人事機密UI撤去方針と整合。給与は Payroll 側が正）。
--
-- ⚠️ 運用（公開は裕鵬さんの操作。この migration は draft 止まり）:
--   1. 裕鵬さんがテンプレエディタ（#/missions/templates）で最終校正
--      • 組織VISION【定量】【定性】の今期文言（heading のプレースホルダ差替え）
--      • KPI ウエイト（暫定 40/30/30・合計100）と閾値表の確定
--        —— published 後は変更経路がない既知制約。公開前に必ず確定すること
--      • 各フェーズ締切日（deadlines）
--   2. 公開（published）→ 発行タブから一括発行
--
-- 冪等: 固定 UUID + on conflict do nothing（再実行しても draft を重複作成しない。
-- 裕鵬さんが編集した内容を上書きしない）。

begin;

insert into public.mission_templates
  (id, period, title, definition, deadlines, status, calc_version)
values (
  '784a17b5-c173-401d-acd8-64a094617cb4',
  '5H1',
  '5期上期 ミッションシート（目標設計）',
  $definition$
{
  "sections": [
    {
      "id": "profile",
      "title": "基本情報",
      "description": "氏名・所属・役職はシート上部に自動表示されます（従業員マスター連携）。等級と各面談の実施日を記録してください。",
      "questions": [
        {
          "id": "grade",
          "label": "等級（現在のグレード）",
          "type": "select",
          "choices": ["P1", "P2", "P3", "P4", "P5", "S1", "S2", "S3", "S4", "S5", "E1", "E2", "E3", "E4", "E5", "M"],
          "respondent": "self",
          "phase": "goal"
        },
        {
          "id": "interview_goal",
          "label": "目標設定面談 実施日",
          "type": "date",
          "respondent": "self",
          "phase": "goal"
        },
        {
          "id": "interview_mid",
          "label": "中間面談 実施日",
          "type": "date",
          "respondent": "self",
          "phase": "mid"
        },
        {
          "id": "interview_final",
          "label": "振り返り面談 実施日",
          "type": "date",
          "respondent": "self",
          "phase": "final"
        }
      ]
    },
    {
      "id": "vision_company",
      "title": "SHO-SANのVISION / BELIEF",
      "description": "SHO-SANが目指す未来と価値観。あなた自身のVISION・FOCUSはこの延長線上に設計してください。組織VISION【定量】【定性】は期毎にテンプレ編集で更新します。",
      "questions": [
        {
          "id": "vbcf_vision",
          "label": "VISION（目指す未来）：最高の組織で人を幸せにし、最強の事業で日本を牽引する。",
          "type": "heading"
        },
        {
          "id": "vbcf_belief",
          "label": "BELIEF（価値観・信念）：楽しむ人が、社会を変える。",
          "type": "heading"
        },
        {
          "id": "org_vision_quant",
          "label": "組織VISION【定量】：（今期の定量目標をテンプレ編集で記載）",
          "type": "heading"
        },
        {
          "id": "org_vision_qual",
          "label": "組織VISION【定性】：（今期の定性目標をテンプレ編集で記載）",
          "type": "heading"
        }
      ]
    },
    {
      "id": "vision_self",
      "title": "あなたのVISION / FOCUS",
      "questions": [
        {
          "id": "vision_longterm",
          "label": "あなたのVISION【中長期】",
          "type": "textarea",
          "required": true,
          "respondent": "self",
          "phase": "goal",
          "help": "2〜3年後に実現していたい姿を、仕事・キャリアの両面から言語化してください。"
        },
        {
          "id": "focus_shortterm",
          "label": "あなたのFOCUS【短期】",
          "type": "textarea",
          "required": true,
          "respondent": "self",
          "phase": "goal",
          "help": "VISIONから逆算して、今期フォーカスするテーマを記入してください。"
        }
      ]
    },
    {
      "id": "credo",
      "title": "CREDO（スタンス評価）",
      "description": "7つのCREDOを本人・上長がそれぞれ期初・期末に○△✕で評価します。今期特に体現したい項目には「注力テーマ」のチェックを入れてください。",
      "questions": [
        {
          "id": "credo_01",
          "label": "規律",
          "type": "credo_eval",
          "required": true,
          "respondent": "both",
          "phase": "goal",
          "credo": { "no": "01", "phrase": "まず、“賞賛”される人であれ。" }
        },
        {
          "id": "credo_02",
          "label": "強み",
          "type": "credo_eval",
          "required": true,
          "respondent": "both",
          "phase": "goal",
          "credo": { "no": "02", "phrase": "強みで暴れろ。" }
        },
        {
          "id": "credo_03",
          "label": "挑戦スピード",
          "type": "credo_eval",
          "required": true,
          "respondent": "both",
          "phase": "goal",
          "credo": { "no": "03", "phrase": "迷ったら、飛べ。" }
        },
        {
          "id": "credo_04",
          "label": "当事者意識",
          "type": "credo_eval",
          "required": true,
          "respondent": "both",
          "phase": "goal",
          "credo": { "no": "04", "phrase": "私事（仕事）を楽しめ。" }
        },
        {
          "id": "credo_05",
          "label": "自責自発",
          "type": "credo_eval",
          "required": true,
          "respondent": "both",
          "phase": "goal",
          "credo": { "no": "05", "phrase": "責任は奪え、答えも奪え。" }
        },
        {
          "id": "credo_06",
          "label": "フラット協力",
          "type": "credo_eval",
          "required": true,
          "respondent": "both",
          "phase": "goal",
          "credo": { "no": "06", "phrase": "議論は全開で、決まったら一丸で。" }
        },
        {
          "id": "credo_07",
          "label": "組織ファースト",
          "type": "credo_eval",
          "required": true,
          "respondent": "both",
          "phase": "goal",
          "credo": { "no": "07", "phrase": "独りを捨て、仲間を選べ。" }
        },
        {
          "id": "credo_action_theme",
          "label": "CREDO 具体的な行動テーマ（期初）",
          "type": "textarea",
          "required": true,
          "respondent": "self",
          "phase": "goal",
          "help": "注力テーマに選んだCREDOを、日々の行動レベルに落とした目標を記入してください。"
        },
        {
          "id": "credo_review",
          "label": "CREDO 振り返り（期末）",
          "type": "textarea",
          "respondent": "self",
          "phase": "final"
        },
        {
          "id": "credo_evaluator_comment",
          "label": "CREDOへの上長コメント（期末）",
          "type": "textarea",
          "respondent": "evaluator",
          "phase": "final"
        }
      ]
    },
    {
      "id": "sixsense",
      "title": "6SENSE（スキル）",
      "description": "組織の一員として個々に期待される6つのスキル。今期活かしたい強みを選び、取り組みテーマを設計してください。",
      "questions": [
        {
          "id": "sixsense_strength",
          "label": "活かしたい強み（6SENSE）",
          "type": "select",
          "choices": [
            "思考力（THINKING）",
            "突破力（BREAKTHROUGH）",
            "統率力（LEADERSHIP）",
            "回復力（RESILIENCE）",
            "創造力（CREATIVITY）",
            "探究力（INQUIRY）"
          ],
          "required": true,
          "respondent": "self",
          "phase": "goal"
        },
        {
          "id": "sixsense_likes",
          "label": "好きなこと・得意なこと",
          "type": "textarea",
          "respondent": "self",
          "phase": "goal",
          "help": "強みの土台になる「好き・得意」を自由に記入してください。"
        },
        {
          "id": "sixsense_theme",
          "label": "6SENSE 取り組みテーマ",
          "type": "textarea",
          "required": true,
          "respondent": "self",
          "phase": "goal",
          "help": "選んだ強みを今期どの業務でどう活かすかを具体化してください。"
        },
        {
          "id": "sixsense_review",
          "label": "6SENSE 振り返り（期末）",
          "type": "textarea",
          "respondent": "self",
          "phase": "final"
        },
        {
          "id": "sixsense_evaluator_comment",
          "label": "6SENSEへの上長コメント（期末）",
          "type": "textarea",
          "respondent": "evaluator",
          "phase": "final"
        }
      ]
    },
    {
      "id": "results",
      "title": "成果（KPI目標）",
      "description": "今期の成果目標をKPIとして設定します（数値・単位まで具体化）。⚠️ウエイトは暫定値（40/30/30）— 公開前に必ず確定してください（公開後は変更できません）。",
      "questions": [
        {
          "id": "kpi_goal_1",
          "label": "KPI目標 1",
          "type": "kpi_goal",
          "required": true,
          "respondent": "both",
          "phase": "goal",
          "weight": 40
        },
        {
          "id": "kpi_goal_2",
          "label": "KPI目標 2",
          "type": "kpi_goal",
          "respondent": "both",
          "phase": "goal",
          "weight": 30
        },
        {
          "id": "kpi_goal_3",
          "label": "KPI目標 3",
          "type": "kpi_goal",
          "respondent": "both",
          "phase": "goal",
          "weight": 30
        }
      ]
    },
    {
      "id": "midterm",
      "title": "中間振り返り",
      "description": "期の折り返しでの進捗・課題・後半のアクションを整理します（中間面談で使用）。",
      "questions": [
        {
          "id": "mid_self_review",
          "label": "進捗と後半のアクション（本人）",
          "type": "textarea",
          "respondent": "self",
          "phase": "mid"
        },
        {
          "id": "mid_evaluator_comment",
          "label": "中間面談での上長コメント",
          "type": "textarea",
          "respondent": "evaluator",
          "phase": "mid"
        }
      ]
    },
    {
      "id": "fundamental",
      "title": "アタリマエ評価",
      "description": "社会人・SHO-SANメンバーとしてのアタリマエ基準。上長評価で✕が1つでもあるとランクはCが上限になります（期末に○/×で評価）。",
      "questions": [
        {
          "id": "fund_punctual",
          "label": "遅刻数（前日までの報告以外の遅刻が半期3回以下・例外なし）",
          "type": "select",
          "choices": ["○", "×"],
          "respondent": "both",
          "phase": "final",
          "is_fundamental": true
        },
        {
          "id": "fund_attitude",
          "label": "勤務態度",
          "type": "select",
          "choices": ["○", "×"],
          "respondent": "both",
          "phase": "final",
          "is_fundamental": true
        },
        {
          "id": "fund_hourensou",
          "label": "報連相",
          "type": "select",
          "choices": ["○", "×"],
          "respondent": "both",
          "phase": "final",
          "is_fundamental": true
        },
        {
          "id": "fund_rules",
          "label": "ルール遵守",
          "type": "select",
          "choices": ["○", "×"],
          "respondent": "both",
          "phase": "final",
          "is_fundamental": true
        },
        {
          "id": "fund_ai_media",
          "label": "AI情報局の視聴（毎月参加or録画視聴＋出席クイズ期限内正解）",
          "type": "select",
          "choices": ["○", "×"],
          "respondent": "both",
          "phase": "final",
          "is_fundamental": true
        }
      ]
    },
    {
      "id": "bonus",
      "title": "加点評価・期末総評",
      "description": "ミッション外の会社貢献・チャレンジへの加点（上長が点数を手入力。目安1件3点）。",
      "questions": [
        {
          "id": "bonus_points",
          "label": "加点（点）",
          "type": "number",
          "respondent": "evaluator",
          "phase": "final",
          "is_bonus": true,
          "help": "加点対象の取り組みと点数の根拠は上長コメントに記載してください。"
        },
        {
          "id": "bonus_comment",
          "label": "加点理由・期末総評（上長コメント）",
          "type": "textarea",
          "respondent": "evaluator",
          "phase": "final"
        },
        {
          "id": "final_self_review",
          "label": "期末の自己振り返り",
          "type": "textarea",
          "respondent": "self",
          "phase": "final"
        }
      ]
    }
  ],
  "calc": {
    "thresholds": [
      { "grade": "A+", "min": 141 },
      { "grade": "A", "min": 121 },
      { "grade": "B+", "min": 111 },
      { "grade": "B", "min": 101 },
      { "grade": "B-", "min": 91 },
      { "grade": "C", "min": 71 },
      { "grade": "D", "min": 0 }
    ]
  }
}
  $definition$::jsonb,
  '{}'::jsonb,
  'draft',
  1
)
on conflict (id) do nothing;

commit;
