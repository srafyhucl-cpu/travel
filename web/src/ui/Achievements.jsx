import React, { useMemo, useState } from 'react';
import { useStore } from './useStore.js';
import { computeAchievements } from '../core/achievements.js';
import { formatDate, tintOf } from '../core/format.js';
import { Bar, Icon, Sheet } from './bits.jsx';

/** 徽章日期按本地自然日显示（快照里是 UTC ISO） */
function dayOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 成就页：顶部切人（全队 / 我 / 其他成员），下面是徽章网格。
 * 未解锁的灰显、带进度条；已解锁的显示达成日期。
 */
export default function Achievements({ onClose }) {
  const state = useStore();
  const data = state.data;
  const [pick, setPick] = useState('team');

  const model = useMemo(() => (data ? computeAchievements(data) : null), [data]);
  if (!data || !model) return null;

  const meId = data.meId || model.memberList.find((m) => m.name === data.me)?.id || null;
  const list = pick === 'team' ? model.team : model.byMember[pick] || [];
  const unlocked = list.filter((b) => b.done).length;

  return (
    <Sheet title="成就" onClose={onClose}>
      <div className="stack">
        <div className="pill-row scroll">
          <button className={`pill${pick === 'team' ? ' on' : ''}`} onClick={() => setPick('team')}>
            全队 {model.team.filter((b) => b.done).length}/{model.team.length}
          </button>
          {model.memberList.map((m) => (
            <button key={m.id} className={`pill${pick === m.id ? ' on' : ''}`} onClick={() => setPick(m.id)}>
              {m.name}
              {m.id === meId && m.name !== '我' && <span className="me-tag">我</span>}
            </button>
          ))}
        </div>

        <div className="tiny dim ach-sum">
          已解锁 {unlocked}/{list.length} · 成就从行程、打卡、照片和记账里自动算，不用手动领
        </div>

        <div className="ach-grid">
          {list.map((b) => (
            <div key={b.id} className={`ach-card${b.done ? '' : ' locked'}`}>
              <span className="ach-ic" style={b.done ? { background: tintOf(b.color), color: b.color } : null}>
                <Icon name={b.icon} size={18} />
              </span>
              <div className="grow">
                <div className="small strong">{b.title}</div>
                <div className="tiny dim">{b.desc}</div>
                {b.done ? (
                  b.at && <div className="ach-at">{formatDate(dayOf(b.at), { short: true })} 达成</div>
                ) : (
                  b.progress &&
                  b.progress.total > 0 && (
                    <div style={{ marginTop: 6 }}>
                      <Bar value={b.progress.done} max={b.progress.total} />
                      <div className="ach-prog tiny dim">
                        {b.progress.done}/{b.progress.total}
                      </div>
                    </div>
                  )
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Sheet>
  );
}
