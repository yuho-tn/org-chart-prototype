import { useOrgStore } from "../store/useOrgStore";

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function LogPanel() {
  const log = useOrgStore((s) => s.log);
  return (
    <footer className="logpanel">
      <h3 className="logpanel__title">操作ログ（直近{log.length}件）</h3>
      <ul className="logpanel__list">
        {log.length === 0 && <li className="logpanel__empty">操作はまだありません</li>}
        {log.map((e) => (
          <li key={e.id} className={`logpanel__row logpanel__row--${e.action}`}>
            <span className="logpanel__time">{fmtTime(e.ts)}</span>
            <span className="logpanel__action">[{e.action}]</span>
            <span className="logpanel__detail">{e.detail}</span>
          </li>
        ))}
      </ul>
    </footer>
  );
}
