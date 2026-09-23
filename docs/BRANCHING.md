# ブランチ運用ルール

**目的**：2026-09-23 に発覚した「main が2.5ヶ月止まり、本番と87コミット乖離していた」状態を
二度と作らない。ルールはすべて、実際に起きた事故から逆算して書いている。

---

## 1. 原則：main = 本番で動いているもの

`main` は「いつか統合する場所」ではなく **本番の実態を映す鏡**。
main を見れば今お客様が触っているコードが分かる、という状態を常に保つ。

- main への直接コミットはしない。変更は必ずブランチ → PR → マージ。
- **本番へデプロイしたら、その日のうちに main へマージする**（下記 §3）。

### なぜ（2026-09-23 の事故）
`vercel --prod` / `supabase functions deploy` を作業ブランチから直接打つ運用が続き、
main へのマージだけが抜け落ちた。結果：

- main の最終コミットが 2026-07-07 で凍結、本番との差が **87コミット / 143ファイル / +29,453行**
- ブランチが14本堆積し、どれが本番か判別不能に
- PR #2 が2ヶ月 OPEN のまま放置
- migration 番号の衝突（`0021_user_admin_containment` vs `0021_pulse_survey`）で、
  作った機能が**取り込めなくなって死んだ**

---

## 2. ブランチの命名と寿命

| 接頭辞 | 用途 | 例 |
|---|---|---|
| `feat/` | 機能追加 | `feat/pulse-v3-p2` |
| `fix/` | 不具合修正 | `fix/smarthr-subdomain-rename` |
| `docs/` | ドキュメントのみ | `docs/branching-policy` |
| `chore/` | 依存更新・設定 | `chore/bump-vite` |
| `release/` | 複数ブランチの統合（例外運用） | `release/main-sync-20260923` |

- **1ブランチ = 1まとまり**。別件を相乗りさせない。
- **必ず最新の `origin/main` から切る**。前の作業ブランチから枝分かれさせない
  （これをやると、親がマージされるまで子もマージできず、連鎖で滞留する）。
- **寿命は原則1週間以内**。超えそうなら分割する。
- マージ済みブランチは削除する（履歴は main に残る）。

---

## 3. デプロイとマージの順序（最重要）

本番反映を伴う作業は、**必ずこの順**で行う。

```
1. ブランチで実装
2. PR を作成
3. main へマージ
4. main から本番デプロイ（vercel --prod / supabase functions deploy）
```

やむを得ずブランチから先にデプロイした場合（ホットフィックス等）は、
**同じ日のうちに PR を出して main へマージする**。ここを翌日に送ると、そのまま2ヶ月放置される。

### 例外：secret / 環境変数だけの修正
`supabase secrets set` や Vercel env の変更はコードに現れない。
コード変更を伴わなくても、**何を変えたかを PR かコミットのコメントに残す**
（2026-09-23 の SmartHR 復旧は secret 更新が実体で、コードには痕跡が残らなかった）。

---

## 4. migration の採番

`supabase/migrations/NNNN_name.sql` の `NNNN` は **`origin/main` にある最大値 + 1** で取る。
作業ブランチの最大値ではない。

```bash
git fetch origin
git ls-tree --name-only origin/main supabase/migrations/ | tail -1
```

並行ブランチで同じ番号を取ってしまった場合、**後からマージする側が採番し直す**。

### なぜ番号の重複が特に危ないか（2026-09-23 実測）

`supabase migration list` は **版番号だけで突き合わせる**。中身は見ない。
そのため、番号が同じで中身が別物の migration が「適用済み（local と remote が一致）」として
表示される。実際に、ローカルの `0052_smarthr_sync_alert` と本番の
`0052_user_admin_containment` が一致扱いで並んでいた。

結果、重複番号は2通りの壊れ方をする。**後者の方が危険。**

1. **`db push` が落ちる**
   本番にある版が手元に無いと
   `LegacyDbPushMissingLocalError: Remote migration versions not found in local migrations directory`
   で**全migrationを拒否**する。1件の乖離で、無関係な migration まで一切適用できなくなる。
2. **`db push` が落ちずに、黙ってスキップする**
   番号が既に履歴にあると「適用済み」と判断して**何も言わずに飛ばす**。
   migration を書いてマージしてデプロイしても、**本番には入っていないのに誰も気づかない。**

CLI は落ちた時に `supabase migration repair --status reverted <version>` を提案してくるが、
**安易に使わない**。その版を「未適用」扱いに戻すため、別ブランチが後から `db push` した時に
再適用される。正しい対処は、**本番に入っている migration を main へ取り込んで乖離を消すこと**。

`db push` の前に必ず `--dry-run` で対象を確認する。想定外の版が並んでいたら、そこで止める。

---

## 5. PR の扱い

- PR は **72時間以内**にマージするか閉じる。判断待ちで寝かせない。
- 本番反映済みの内容を後追いで PR にする場合は、タイトルに `release:` を付け、
  本文に「本番デプロイ済み・新規未検証コードなし」と明記する。
- レビューなしでマージしてよいのは、**本番で既に動作確認済み**のものだけ。

---

## 6. worktree を使うとき

複数ブランチを並行で触る時は `git worktree` を使う（このリポジトリでは実績あり）。

```bash
git worktree add ../org-chart-prototype.<name> -b feat/<name> origin/main
git worktree list   # 今どこで何を触っているかを必ず確認
```

- **同じ作業ディレクトリを複数のセッション（人・エージェント）で共有しない**。
  片方の未コミット変更をもう片方が巻き込む。
- `git add -A` は使わない。**パスを明示して add する**（共有ワークツリー事故の防止）。

---

## 7. 定期点検（月1）

```bash
git fetch origin --prune
git branch -r --merged origin/main   # 消してよいブランチ
git branch -r --no-merged origin/main # 未反映＝滞留の疑い
gh pr list --state open              # 放置PR
```

`--no-merged` に出たブランチは「まだ main に入っていない作業」。
1ヶ月以上動いていないものは、取り込むか捨てるかをその場で決める。
