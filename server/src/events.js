/**
 * 极简 SSE 广播中心。
 * 任何写操作后调用 broadcast(tripId, payload)，该旅行所有在线客户端会收到通知去重新拉取。
 */
const clients = new Map(); // tripId -> Set<res>

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

export function broadcast(tripId, payload) {
  const set = clients.get(tripId);
  if (!set || set.size === 0) return 0;
  const line = `data: ${JSON.stringify(payload)}\n\n`;
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
