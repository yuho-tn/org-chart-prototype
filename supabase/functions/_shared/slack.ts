// Slack DM 共有ユーティリティ（users.lookupByEmail → chat.postMessage）。
//
// pulse-notify/index.ts に元々あった同名ロジックをそのまま関数として切り出したもの
// （PULSE_V3_DESIGN.md §10-6 ⑤）。pulse-notify 自体は自己完結の実装を保持したまま
// 変更しない（リグレッション回避のため。このモジュールへの差し替えは行わない）。
// pulse-alert-digest（daily/immediate）が利用する。
//
// 失敗（lookup不可・post失敗・例外）はすべて false を返す（呼び出し元が件数を集計する）。

export async function slackDM(token: string, email: string, text: string): Promise<boolean> {
  if (!token) return false;
  try {
    const lookup = await fetch(
      "https://slack.com/api/users.lookupByEmail?email=" + encodeURIComponent(email),
      { headers: { Authorization: "Bearer " + token } },
    ).then((r) => r.json());
    const uid = lookup?.user?.id;
    if (!lookup?.ok || !uid) return false;

    const post = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: uid, text }),
    }).then((r) => r.json());
    return !!post?.ok;
  } catch {
    return false;
  }
}
