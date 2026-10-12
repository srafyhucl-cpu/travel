/**
 * 极简 SSE 广播中心。
 * 任何写操作后调用 broadcast(tripId, payload)，该旅行所有在线客户端会收到通知去重新拉取。
 *
 * 这里同时维护一个轻量的「数据版本号 rev」：轮询端（小程序 20s 轮询）先拉
 * /api/trip/rev 对比，没变就不拉全量快照，省流量也省唤醒。
 * rev 只需进程内单调递增：客户端只比较「是否相等」，进程重启后归零也安全
 * （最多触发一次多余的全量拉取）。
 */
const clients = new Map(); // tripId -> Set<res>
const revs = new Map(); // tripId -> number

export function addClient(tripId, res) {
  if (!clients.has(tripId)) clients.set(tripId, new Set());
  clients.get(tripId).add(res);
  res.on('close', () => {
    const set = clients.get(tripId);
    if (set) {
      set.delete(res);
      if (set.size === 0) clients.delete(tripId);
    }
  });
}

/** 当前数据版本号（没有写操作时保持不变） */
export function currentRev(tripId) {
  return revs.get(tripId) || 0;
}

export function broadcast(tripId, payload) {
  // 先步进版本号：不管有没有在线的 SSE 流，轮询端都要能感知到这次变化
  const rev = currentRev(tripId) + 1;
  revs.set(tripId, rev);

  const set = clients.get(tripId);
  if (!set || set.size === 0) return 0;
  const line = `data: ${JSON.stringify({ ...payload, rev })}\n\n`;
  let sent = 0;
  for (const res of set) {
    try {
      res.write(line);
      sent++;
    } catch {
      set.delete(res);
    }
  }
  return sent;
}

export function clientCount(tripId) {
  return clients.get(tripId)?.size ?? 0;
}
