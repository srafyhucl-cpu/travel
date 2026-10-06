import React, { useEffect, useRef, useState } from 'react';
import { useStore } from './ui/useStore.js';
import { Icon, Sheet, Field } from './ui/bits.jsx';
import { NodePickField } from './ui/pickers.jsx';
import Login from './ui/Login.jsx';
import Journey from './ui/Journey.jsx';
import Settings from './ui/Settings.jsx';
import Poster from './ui/Poster.jsx';
import { actions } from './store/store.js';
import { queue } from './store/idb.js';

export default function App() {
  const state = useStore();
  const [panel, setPanel] = useState(null); // 'settings' | 'poster' | 'add'
  const [addNodeSignal, setAddNodeSignal] = useState(0);
  const [expenseSignal, setExpenseSignal] = useState(0);
  const [pending, setPending] = useState(0);

  React.useEffect(() => {
    queue.size().then(setPending).catch(() => {});
  }, [state.data, state.online]);

  /*
   * 主屏长按图标的那三个快捷方式，全靠 ?tab= 传进来。manifest 里定义了，
   * 但代码压根没读这个参数，长按弹出来点哪个都是同一个首页，等于三个假入口。
   * 而长按菜单恰恰是用户明确表达意图的时刻，都落到首页就浪费了。
   */
  useEffect(() => {
    if (state.phase === 'boot') return undefined;
    const apply = () => {
      const tab = new URLSearchParams(window.location.search).get('tab');
      if (!tab) return;
      if (tab === 'money') {
        // 记账面板在 Journey 里，用递增信号把它叫醒（和「加一项」同一套路）
        setExpenseSignal((n) => n + 1);
        setPanel(null);
      } else if (tab === 'photos') {
        // 现在 vlog 图默认是行程长图，没照片也能出，直接开面板。
        setPanel('poster');
      }
      // 参数用完抹掉：不然刷新一下、或者从后台切回来，历史里还留着这个
      // tab，回退时又弹一次记账面板。
      window.history.replaceState(null, '', window.location.pathname);
    };
    apply();
    window.addEventListener('popstate', apply);
    return () => window.removeEventListener('popstate', apply);
  }, [state.phase, state.data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.phase === 'boot') {
    return (
      <div className="auth">
        <div className="stack">
          <div className="skeleton" />
          <div className="skeleton" style={{ height: 110 }} />
        </div>
      </div>
    );
  }

  if (state.phase === 'login') return <Login />;

  return (
    <div className="app">
      {!state.online && <div className="net-flag">离线中</div>}
      {state.online && pending > 0 && (
        <div className="net-flag" style={{ background: 'rgba(47,128,237,.92)' }}>
          {pending} 条待同步
        </div>
      )}

      <Journey
        addNodeSignal={addNodeSignal}
expenseSignal={expenseSignal}
        onAdd={() => setPanel('add')}
        onOpenSettings={() => setPanel('settings')}
      />

      {panel === 'settings' && (
        <Sheet title="设置" onClose={() => setPanel(null)}>
          <Settings embedded onOpenPoster={() => setPanel('poster')} />
        </Sheet>
      )}

      {panel === 'poster' && state.data && (
        <Poster photos={state.data.photos} trip={state.data.trip} onClose={() => setPanel(null)} />
      )}

      {panel === 'add' && (
        <QuickAdd
          nodes={state.data?.nodes || []}
          onClose={() => setPanel(null)}
          onAddNode={() => {
            setPanel(null);
            setAddNodeSignal((n) => n + 1);
          }}
        />
      )}

      {state.toast && <div className={`toast ${state.toast.kind}`}>{state.toast.message}</div>}
    </div>
  );
}

/** 右上角那个 + ：放照片最快，加一项次之。记账在时间线上对应那项里点。 */
function QuickAdd({ nodes, onClose, onAddNode }) {
  const fileRef = useRef(null);
  const [nodeId, setNodeId] = useState('');
  const [busy, setBusy] = useState(false);

  async function pick(ev) {
    const files = [...(ev.target.files || [])];
    ev.target.value = '';
    if (!files.length) return;
    setBusy(true);
    try {
      const fd = new FormData();
      for (const f of files) fd.append('photos', f);
      if (nodeId) fd.append('nodeId', nodeId);
      await actions.uploadPhotos(fd);
      onClose();
    } catch {
      /* store 弹过了 */
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="加一笔" onClose={onClose}>
      <div className="stack">
        <div className="quickgrid">
          <button className="quickcell" onClick={() => fileRef.current?.click()} disabled={busy}>
            <Icon name="camera" size={19} />
            <span>{busy ? '上传中' : '传照片'}</span>
          </button>
          <button className="quickcell" onClick={onAddNode}>
            <Icon name="plus" size={19} />
            <span>加一项</span>
          </button>
        </div>

        <Field label="传给哪一项" hint="不选就进「随手记」">
          <NodePickField nodes={nodes} value={nodeId} onChange={setNodeId} emptyLabel="不指定" />
        </Field>

        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/gif"
          multiple
          onChange={pick}
          style={{ display: 'none' }}
        />
      </div>
    </Sheet>
  );
}
