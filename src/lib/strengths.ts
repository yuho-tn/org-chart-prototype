/**
 * P3: ストレングスファインダー（CliftonStrengths）34資質マスター。
 *   • 34資質から5つを順位付きで選択する（1〜5位・重複不可）。保存は
 *     employee_profiles.strengths（jsonb string[]・配列順＝順位）に資質 id を入れる。
 *   • 4領域カラー：実行力=紫 / 影響力=オレンジ / 人間関係構築力=青 / 戦略的思考力=緑
 *   • description は自前の日本語短文（裕鵬さん提供シート受領後に差し替え可能な構造）。
 */

export type StrengthDomain =
  | "executing"
  | "influencing"
  | "relationship"
  | "strategic";

export const STRENGTH_DOMAIN_LABEL: Record<StrengthDomain, string> = {
  executing: "実行力",
  influencing: "影響力",
  relationship: "人間関係構築力",
  strategic: "戦略的思考力",
};

/** 4領域カラー（要件 7-4）。バッジ背景・ドット・凡例で共用。 */
export const STRENGTH_DOMAIN_COLOR: Record<StrengthDomain, string> = {
  executing: "#7C3AED", // 紫
  influencing: "#EA7317", // オレンジ
  relationship: "#2563EB", // 青
  strategic: "#16A34A", // 緑
};

export type StrengthQuality = {
  /** 安定 id（英語資質名の小文字）。保存値に使う。 */
  id: string;
  /** 日本語資質名。 */
  name_ja: string;
  /** 英語資質名。 */
  name_en: string;
  domain: StrengthDomain;
  /** 自前の短い説明（差し替え可能）。 */
  description: string;
  /** 公式（Gallup）由来の詳細説明。未設定なら description にフォールバックする。 */
  detail?: string;
  /** 公式（Gallup）由来の英語原文。 */
  detail_en?: string;
  /** detail の出典表記（例: "Gallup CliftonStrengths"）。 */
  detail_source?: string;
  /** 出典 URL。 */
  detail_url?: string;
};

/** CliftonStrengths 34資質（4領域）。順序は領域→一般的な並び。 */
export const STRENGTHS: StrengthQuality[] = [
  // ── 実行力（Executing）9資質 ──
  { id: "achiever", name_ja: "達成欲", name_en: "Achiever", domain: "executing", description: "常に何かを成し遂げたいという強い欲求を持ち、日々の達成感を原動力にする。", detail: "達成欲の資質に秀でた人は勤勉で、大きな持久力を持っています。忙しく生産的であることに大きな満足感を覚えます。", detail_en: "People exceptionally talented in the Achiever theme work hard and possess a great deal of stamina. They take immense satisfaction in being busy and productive.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252134/achiever-theme.aspx" },
  { id: "arranger", name_ja: "アレンジ", name_en: "Arranger", domain: "executing", description: "人やリソースを最適に組み合わせ、変化に応じて柔軟に段取りを組み直せる。", detail: "アレンジの資質に秀でた人は物事を整理する能力を持ちながら、それを補う柔軟性も備えています。あらゆる要素やリソースをどう組み合わせれば最大限の生産性が得られるかを考えることを好みます。", detail_en: "People exceptionally talented in the Arranger theme can organize, but they also have a flexibility that complements this ability. They like to determine how all of the pieces and resources can be arranged for maximum productivity.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252161/arranger-theme.aspx" },
  { id: "belief", name_ja: "信念", name_en: "Belief", domain: "executing", description: "揺るがない核となる価値観を持ち、それが人生と仕事に一貫した意味を与える。", detail: "信念の資質に秀でた人は、揺るぎない中核的な価値観を持っています。その価値観から、人生における明確な目的が生まれます。", detail_en: "People exceptionally talented in the Belief theme have certain core values that are unchanging. Out of these values emerges a defined purpose for their lives.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252170/belief-theme.aspx" },
  { id: "consistency", name_ja: "公平性", name_en: "Consistency", domain: "executing", description: "誰もが平等に扱われるべきと考え、明確なルールで一貫性を保つ。", detail: "公平性の資質に秀でた人は、すべての人を同じように扱う必要性を強く意識しています。誰もが従える安定したルーティンと、明確なルール・手順を求めます。", detail_en: "People exceptionally talented in the Consistency theme are keenly aware of the need to treat people the same. They crave stable routines and clear rules and procedures that everyone can follow.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252203/consistency-theme.aspx" },
  { id: "deliberative", name_ja: "慎重さ", name_en: "Deliberative", domain: "executing", description: "決断の前にリスクを丁寧に見極め、慎重に選択を積み重ねる。", detail: "慎重さの資質に秀でた人は、意思決定や選択を行う際に細心の注意を払うことが特徴です。彼らは障害をあらかじめ予測します。", detail_en: "People exceptionally talented in the Deliberative theme are best described by the serious care they take in making decisions or choices. They anticipate obstacles.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252215/deliberative-theme.aspx" },
  { id: "discipline", name_ja: "規律性", name_en: "Discipline", domain: "executing", description: "秩序と構造を好み、計画・ルーティンで物事を確実に前へ進める。", detail: "規律性の資質に秀でた人はルーティンと構造を好みます。彼らの世界は、自ら作り出す秩序によって最もよく説明されます。", detail_en: "People exceptionally talented in the Discipline theme enjoy routine and structure. Their world is best described by the order they create.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252227/discipline-theme.aspx" },
  { id: "focus", name_ja: "目標志向", name_en: "Focus", domain: "executing", description: "目的地を定め、そこに向けて優先順位を絞り込み無駄なく進む。", detail: "目標志向の資質に秀でた人は、方向性を定め、それをやり遂げ、軌道を保つために必要な修正を行うことができます。まず優先順位をつけ、それから行動します。", detail_en: "People exceptionally talented in the Focus theme can take a direction, follow through and make the corrections necessary to stay on track. They prioritize, then act.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252239/focus-theme.aspx" },
  { id: "responsibility", name_ja: "責任感", name_en: "Responsibility", domain: "executing", description: "引き受けたことは必ずやり遂げ、約束と誠実さを何より重んじる。", detail: "責任感の資質に秀でた人は、自分が言ったことに対して心理的なオーナーシップを持ちます。誠実さや忠誠心といった安定した価値観に強くコミットしています。", detail_en: "People exceptionally talented in the Responsibility theme take psychological ownership of what they say they will do. They are committed to stable values such as honesty and loyalty.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252320/responsibility-theme.aspx" },
  { id: "restorative", name_ja: "回復志向", name_en: "Restorative", domain: "executing", description: "問題を見つけ出し、原因を突き止めて解決することにやりがいを感じる。", detail: "回復志向の資質に秀でた人は、問題に対処することに長けています。何が悪いのかを見極め、それを解決することが得意です。", detail_en: "People exceptionally talented in the Restorative theme are adept at dealing with problems. They are good at figuring out what is wrong and resolving it.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252323/restorative-theme.aspx" },

  // ── 影響力（Influencing）8資質 ──
  { id: "activator", name_ja: "活発性", name_en: "Activator", domain: "influencing", description: "考えを即行動に移し、動き出すことで物事を前進させる。", detail: "活発性の資質に秀でた人は、考えを行動に移すことで物事を実現させることができます。単に話し合うのではなく、今すぐ行動したいと考えます。", detail_en: "People exceptionally talented in the Activator theme can make things happen by turning thoughts into action. They want to do things now rather than simply talk about them.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252140/activator-theme.aspx" },
  { id: "command", name_ja: "指令性", name_en: "Command", domain: "influencing", description: "主導権を握り、状況を明確にして周囲を決断へ導く。", detail: "指令性の資質に秀でた人は存在感があります。状況をコントロールし、決断を下すことができます。", detail_en: "People exceptionally talented in the Command theme have presence. They can take control of a situation and make decisions.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252176/command-theme.aspx" },
  { id: "communication", name_ja: "コミュニケーション", name_en: "Communication", domain: "influencing", description: "考えや情報を言葉にして生き生きと伝え、人を惹きつける。", detail: "コミュニケーションの資質に秀でた人は、自分の考えを言葉にすることを容易だと感じる傾向があります。優れた会話力とプレゼンテーション能力を持っています。", detail_en: "People exceptionally talented in the Communication theme generally find it easy to put their thoughts into words. They are good conversationalists and presenters.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252185/communication-theme.aspx" },
  { id: "competition", name_ja: "競争性", name_en: "Competition", domain: "influencing", description: "他者との比較を糧にし、1番になることでパフォーマンスを高める。", detail: "競争性の資質に秀でた人は、自分の進歩を他者のパフォーマンスと比較して測ります。一番になることを目指し、競い合うことに喜びを感じます。", detail_en: "People exceptionally talented in the Competition theme measure their progress against the performance of others. They strive to win first place and revel in contests.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252191/competition-theme.aspx" },
  { id: "maximizer", name_ja: "最上志向", name_en: "Maximizer", domain: "influencing", description: "平均ではなく卓越を目指し、強みを一流へ磨き上げることに注力する。", detail: "最上志向の資質に秀でた人は、個人やグループの卓越性を引き出す手段として強みに焦点を当てます。優れたものを最高のものへと変えようとします。", detail_en: "People exceptionally talented in the Maximizer theme focus on strengths as a way to stimulate personal and group excellence. They seek to transform something strong into something superb.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252299/maximizer-theme.aspx" },
  { id: "self_assurance", name_ja: "自己確信", name_en: "Self-Assurance", domain: "influencing", description: "自分の判断と能力を信じ、不確実な状況でも自信を持って進む。", detail: "自己確信の資質に秀でた人は、リスクを取り、自分の人生を管理する能力に自信を持っています。自分の決断に確信を与える内なる羅針盤を持っています。", detail_en: "People exceptionally talented in the Self-Assurance theme feel confident in their ability to take risks and manage their own lives. They have an inner compass that gives them certainty in their decisions.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252332/self-assurance-theme.aspx" },
  { id: "significance", name_ja: "自我", name_en: "Significance", domain: "influencing", description: "重要な存在でありたいと願い、価値ある成果で認められることを目指す。", detail: "自我の資質に秀でた人は、大きなインパクトを与えたいと考えています。独立心が強く、組織や周囲の人々にどれだけの影響を与えられるかによってプロジェクトの優先順位をつけます。", detail_en: "People exceptionally talented in the Significance theme want to make a big impact. They are independent and prioritize projects based on how much influence they will have on their organization or people around them.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252341/significance-theme.aspx" },
  { id: "woo", name_ja: "社交性", name_en: "Woo", domain: "influencing", description: "初対面の人と打ち解けるのが得意で、新たなつながりを築くことを楽しむ。", detail: "社交性の資質に秀でた人は、新しい人々と出会い、彼らを味方につけるという挑戦を好みます。", detail_en: "People exceptionally talented in the Woo theme love the challenge of meeting new people and winning them over.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252359/woo-theme.aspx" },

  // ── 人間関係構築力（Relationship Building）9資質 ──
  { id: "adaptability", name_ja: "適応性", name_en: "Adaptability", domain: "relationship", description: "今この瞬間に柔軟に対応し、予定変更もしなやかに乗りこなす。", detail: "適応性の資質に秀でた人は、流れに身を任せることを好みます。彼らは「今」を生きる人であり、物事をあるがままに受け止め、未来を一日ずつ発見していきます。", detail_en: "People exceptionally talented in the Adaptability theme prefer to go with the flow. They tend to be 'now' people who take things as they come and discover the future one day at a time.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252146/adaptability-theme.aspx" },
  { id: "connectedness", name_ja: "運命思考", name_en: "Connectedness", domain: "relationship", description: "すべての出来事はつながっていると捉え、その意味を大切にする。", detail: "運命思考の資質に秀でた人は、あらゆるものの間につながりがあると信じています。偶然はほとんど存在せず、ほぼすべての出来事には意味があると考えています。", detail_en: "People exceptionally talented in the Connectedness theme have faith in the links among all things. They believe there are few coincidences and that almost every event has meaning.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252197/connectedness-theme.aspx" },
  { id: "developer", name_ja: "成長促進", name_en: "Developer", domain: "relationship", description: "他者の可能性を見抜き、小さな成長を後押しすることに喜びを感じる。", detail: "成長促進の資質に秀でた人は、他者の可能性を見出し、それを育てます。小さな進歩の兆しを見逃さず、成長の証から満足感を得ます。", detail_en: "People exceptionally talented in the Developer theme recognize and cultivate the potential in others. They spot the signs of each small improvement and derive satisfaction from evidence of progress.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252224/developer-theme.aspx" },
  { id: "empathy", name_ja: "共感性", name_en: "Empathy", domain: "relationship", description: "相手の感情を敏感に察知し、その気持ちに寄り添える。", detail: "共感性の資質に秀でた人は、自分自身を他者の人生や状況に置き換えて想像することで、他人の感情を感じ取ることができます。", detail_en: "People exceptionally talented in the Empathy theme can sense other people's feelings by imagining themselves in others' lives or situations.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252236/empathy-theme.aspx" },
  { id: "harmony", name_ja: "調和性", name_en: "Harmony", domain: "relationship", description: "対立を避け、合意点を探ることで人と物事を円滑に進める。", detail: "調和性の資質に秀でた人は、合意を求めます。対立を好まず、むしろ意見が一致する部分を探そうとします。", detail_en: "People exceptionally talented in the Harmony theme look for consensus. They don't enjoy conflict; rather, they seek areas of agreement.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252254/harmony-theme.aspx" },
  { id: "includer", name_ja: "包含", name_en: "Includer", domain: "relationship", description: "誰も取り残さず、輪の中に迎え入れることを自然に行う。", detail: "包含の資質に秀でた人は、他者を受け入れます。仲間外れになっていると感じている人に気づき、彼らを迎え入れようと努力します。", detail_en: "People exceptionally talented in the Includer theme accept others. They show awareness of those who feel left out and make an effort to include them.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252266/includer-theme.aspx" },
  { id: "individualization", name_ja: "個別化", name_en: "Individualization", domain: "relationship", description: "一人ひとりの個性を見極め、その人に合った関わり方をする。", detail: "個別化の資質に秀でた人は、一人ひとりが持つ独自の特性に強い関心を持ちます。異なるタイプの人々がどうすれば生産的に協力できるかを見出す才能を持っています。", detail_en: "People exceptionally talented in the Individualization theme are intrigued with the unique qualities of each person. They have a gift for figuring out how different people can work together productively.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252272/individualization-theme.aspx" },
  { id: "positivity", name_ja: "ポジティブ", name_en: "Positivity", domain: "relationship", description: "熱意と前向きさで周囲を明るくし、場のエネルギーを高める。", detail: "ポジティブの資質に秀でた人は、周囲に伝わる熱意を持っています。前向きで、自分たちがこれから行うことに対して他者を惹きつけ、盛り上げることができます。", detail_en: "People exceptionally talented in the Positivity theme have contagious enthusiasm. They are upbeat and can get others excited about what they are going to do.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252305/positivity-theme.aspx" },
  { id: "relator", name_ja: "親密性", name_en: "Relator", domain: "relationship", description: "少数の深い関係を大切にし、信頼で結ばれたつながりを育む。", detail: "親密性の資質に秀でた人は、他者との親密な関係を楽しみます。友人と力を合わせて目標を達成することに深い満足感を見出します。", detail_en: "People exceptionally talented in the Relator theme enjoy close relationships with others. They find deep satisfaction in working hard with friends to achieve a goal.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252311/relator-theme.aspx" },

  // ── 戦略的思考力（Strategic Thinking）8資質 ──
  { id: "analytical", name_ja: "分析思考", name_en: "Analytical", domain: "strategic", description: "客観的な事実とデータで物事を検証し、根拠を突き詰める。", detail: "分析思考の資質に秀でた人は、理由や原因を追求します。ある状況に影響を与えうるあらゆる要因について考える能力を持っています。", detail_en: "People exceptionally talented in the Analytical theme search for reasons and causes. They have the ability to think about all of the factors that might affect a situation.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252152/analytical-theme.aspx" },
  { id: "context", name_ja: "原点思考", name_en: "Context", domain: "strategic", description: "過去の経緯を踏まえて現在を理解し、判断の土台にする。", detail: "原点思考の資質に秀でた人は、過去について考えることを好みます。その歴史を調べることで、現在を理解します。", detail_en: "People exceptionally talented in the Context theme enjoy thinking about the past. They understand the present by researching its history.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252209/context-theme.aspx" },
  { id: "futuristic", name_ja: "未来志向", name_en: "Futuristic", domain: "strategic", description: "先の可能性を鮮やかに描き、そのビジョンで人を鼓舞する。", detail: "未来志向の資質に秀でた人は、未来やあり得る可能性に心を動かされます。未来のビジョンによって周囲の人々にエネルギーを与えます。", detail_en: "People exceptionally talented in the Futuristic theme are inspired by the future and what could be. They energize others with their visions of the future.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252248/futuristic-theme.aspx" },
  { id: "ideation", name_ja: "着想", name_en: "Ideation", domain: "strategic", description: "新しいアイデアや切り口を次々と生み出すことに喜びを感じる。", detail: "着想の資質に秀でた人は、アイデアに強い関心を持ちます。一見関連のない現象の間につながりを見出すことができます。", detail_en: "People exceptionally talented in the Ideation theme are fascinated by ideas. They are able to find connections between seemingly disparate phenomena.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252260/ideation-theme.aspx" },
  { id: "input", name_ja: "収集心", name_en: "Input", domain: "strategic", description: "情報・知識・モノを集め、いつか役立つ蓄えとして大切にする。", detail: "収集心の資質に秀でた人は、物事を収集し保存したいという欲求を持っています。情報、アイデア、モノ、時には人間関係までも蓄積することがあります。", detail_en: "People exceptionally talented in the Input theme have a need to collect and archive. They may accumulate information, ideas, artifacts or even relationships.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252278/input-theme.aspx" },
  { id: "intellection", name_ja: "内省", name_en: "Intellection", domain: "strategic", description: "深く考えることを好み、思索を通じて理解を掘り下げる。", detail: "内省の資質に秀でた人は、知的な活動によって特徴づけられます。内省的で、知的な議論を好みます。", detail_en: "People exceptionally talented in the Intellection theme are characterized by their intellectual activity. They are introspective and appreciate intellectual discussions.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252284/intellection-theme.aspx" },
  { id: "learner", name_ja: "学習欲", name_en: "Learner", domain: "strategic", description: "学び続けるプロセスそのものに喜びを感じ、成長し続ける。", detail: "学習欲の資質に秀でた人は、学ぶことへの強い欲求を持ち、常に向上したいと考えています。結果よりも学ぶという過程そのものに心を躍らせます。", detail_en: "People exceptionally talented in the Learner theme have a great desire to learn and want to continuously improve. The process of learning, rather than the outcome, excites them.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252293/learner-theme.aspx" },
  { id: "strategic", name_ja: "戦略性", name_en: "Strategic", domain: "strategic", description: "多くの選択肢の中から最短の道筋を素早く見抜く。", detail: "戦略性の資質に秀でた人は、物事を進めるための代替の道筋を作り出します。どんな状況に直面しても、関連するパターンや課題を素早く見抜くことができます。", detail_en: "People exceptionally talented in the Strategic theme create alternative ways to proceed. Faced with any given scenario, they can quickly spot the relevant patterns and issues.", detail_source: "Gallup CliftonStrengths", detail_url: "https://www.gallup.com/cliftonstrengths/en/252350/strategic-theme.aspx" },
];

export function strengthDetailText(q: StrengthQuality): string {
  return q.detail?.trim() || q.description;
}

export const STRENGTH_BY_ID: Record<string, StrengthQuality> = Object.fromEntries(
  STRENGTHS.map((s) => [s.id, s]),
);

/** 資質 id → 表示名（未知 id はそのまま返す＝旧・自由入力値の後方互換）。 */
export function strengthName(id: string): string {
  return STRENGTH_BY_ID[id]?.name_ja ?? id;
}

/** 資質 id → 領域カラー（未知 id はニュートラルグレー）。 */
export function strengthColor(id: string): string {
  const q = STRENGTH_BY_ID[id];
  return q ? STRENGTH_DOMAIN_COLOR[q.domain] : "#6B7280";
}

/** 旧・自由入力の日本語資質名から id へ逆引き（移行の後方互換用）。 */
export const STRENGTH_ID_BY_NAME: Record<string, string> = Object.fromEntries(
  STRENGTHS.map((s) => [s.name_ja, s.id]),
);

/** 保存値（資質 id or 旧・日本語名の混在）を最大5件の id 配列へ正規化。 */
export function normalizeStrengthIds(raw: string[]): string[] {
  const out: string[] = [];
  for (const s of raw) {
    const id = STRENGTH_BY_ID[s] ? s : STRENGTH_ID_BY_NAME[s];
    if (id && !out.includes(id)) out.push(id);
  }
  return out.slice(0, 5);
}
