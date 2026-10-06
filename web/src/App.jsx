import React, { Suspense, useEffect, useRef, useState } from 'react';
import { useStore } from './ui/useStore.js';
import { Icon, Sheet, Field } from './ui/bits.jsx';
import { NodePickField } from './ui/pickers.jsx';
import Login from './ui/Login.jsx';
import Journey from './ui/Journey.jsx';
import Settings from './ui/Settings.jsx';
import { actions } from './store/store.js';
import { platform } from './platform/index.js';

/*
 * 海报/长图带着 ~950 行 Canvas 代码，是低频入口 —— 懒加载，让首屏主包
 * 少背这一段。第一次点「生成 vlog 图」时再拉这个 chunk。
 */
const Poster = React.lazy(() => import('./ui/Poster.jsx'));

/** 懒加载失败（离线且还没缓存过）时兜个底，别让整个 App 跟着崩 */
class LazyBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export default function App() {
  const state = useStore();
  const [panel, setPanel] = useState(null); // 'settings' | 'poster' | 'add'
  const [addNodeSignal, setAddNodeSignal] = useState(0);
  const [expenseSignal, setExpenseSignal] = useState(0);
  const [pending, setPending] = useState(0);

  React.useEffect(() => {
    platform.queue.size().then(setPending).catch(() => {});
  }, [state.data, state.online]);

  /*
   * 首屏之后空闲时把海报 chunk 预热了：主包不背它（首屏更快），
   * 但等用户真要出图时它已经在缓存里；配合 Service Worker，离线也能开。
   */
  useEffect(() => {
    const warm = () => import('./ui/Poster.jsx').catch(() => {});
    if ('requestIdleCallback' in window) {
      const id = requestIdleCallback(warm, { timeout: 5000 });
      return () => cancelIdleCallback(id);
    }
    const t = setTimeout(warm, 3000);
    return () => clearTimeout(t);
  }, []);

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
        <LazyBoundary
          fallback={
            <Sheet title="生成 vlog 图" onClose={() => setPanel(null)}>
              <p className="tiny dim" style={{ margin: 0 }}>
                出图模块还没下载好：第一次打开需要联网一下；下载过一次之后离线也能用。
              </p>
            </Sheet>
          }
        >
          <Suspense
            fallback={
              <Sheet title="生成 vlog 图" onClose={() => setPanel(null)}>
                <div className="skeleton" style={{ height: 240 }} />
              </Sheet>
            }
          >
            <Poster photos={state.data.photos} trip={state.data.trip} onClose={() => setPanel(null)} />
          </Suspense>
        </LazyBoundary>
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
