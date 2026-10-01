import React, { useState } from 'react';
import { actions } from '../store/store.js';
import { useStore } from './useStore.js';
import { Icon } from './bits.jsx';

export default function Login() {
  const state = useStore();
  const [mode, setMode] = useState('login');
  const [passphrase, setPass] = useState('');
  const [name, setName] = useState('');
  const [tripName, setTripName] = useState('');
  const [startDate, setStart] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setErr('');
    setBusy(true);
    try {
      if (mode === 'login') {
        await actions.login(passphrase.trim(), name.trim() || '我');
      } else {
        await actions.createTrip({
          passphrase: passphrase.trim(),
          name: name.trim() || '我',
          tripName: tripName.trim() || '新的旅行',
          startDate,
          endDate: startDate,
        });
      }
    } catch (e) {
      setErr(e?.message || '出错了，请重试');
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = passphrase.trim().length >= 4 && (mode === 'login' || tripName.trim().length > 0);

  return (
    <div className="auth">
      <div className="auth-logo">
<Icon name="pin" size={28} />
      </div>

      <h1>旅行助手</h1>
      <p className="lead">
        {mode === 'login'
          ? '输入同伴给你的口令，就能看到这趟旅行的行程、花销和照片。同一个口令 = 同一趟旅行。'
          : '创建一个新旅行，设定一个口令，把它发给同伴，他输同一个口令就进来了。'}
      </p>

      <form className="stack" onSubmit={submit}>
        <div className="card stack">
          <div className="field">
            <label htmlFor="pass">旅行口令</label>
            <input
              id="pass"
              className="input"
              type="password"
              inputMode="text"
              autoComplete="current-password"
              placeholder="至少 4 位"
              value={passphrase}
              onChange={(e) => setPass(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="who">你是谁</label>
            <input
              id="who"
              className="input"
              placeholder="例如：我 / 小王"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={24}
            />
            <div className="tiny dim">用来记账时标记是谁付的钱。同名会自动认成同一个人。</div>
          </div>

          {mode === 'create' && (
            <>
              <div className="field">
                <label htmlFor="tn">旅行名称</label>
                <input
                  id="tn"
                  className="input"
                  placeholder="例如：川西环线 7 日"
                  value={tripName}
                  onChange={(e) => setTripName(e.target.value)}
                  maxLength={60}
                />
              </div>
              <div className="field">
                <label htmlFor="sd">出发日期</label>
                <input id="sd" className="input" type="date" value={startDate} onChange={(e) => setStart(e.target.value)} />
              </div>
            </>
          )}

          {err && (
            <div className="banner banner-danger">
              <span>{err}</span>
            </div>
          )}

          <button className="btn primary" disabled={!canSubmit || busy} type="submit">
            {busy ? '请稍候…' : mode === 'login' ? '进入这趟旅行' : '创建并进入'}
          </button>
        </div>

        <button
          type="button"
          className="btn ghost btn-sm"
          style={{ alignSelf: 'center' }}
          onClick={() => {
            setMode(mode === 'login' ? 'create' : 'login');
            setErr('');
          }}
        >
          {mode === 'login' ? '还没有？创建一趟新旅行' : '已经有口令了？去登录'}
        </button>

        <div className="tiny dim" style={{ textAlign: 'center', lineHeight: 1.7 }}>
          数据存在你自己的服务器上，不经过任何第三方。
        </div>
      </form>
    </div>
  );
}
