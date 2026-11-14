'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

export type ChatMsg = { id: number; sender: string; body: string; at: string; mine: boolean; isAdmin: boolean };
type Pending = { tempId: number; body: string; at: string; baseId: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clock = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

/** Ghép tin đang gửi (hiện tạm) với tin thật đã về từ máy chủ, mỗi tin thật chỉ ghép một lần. */
function matchPending(pending: Pending[], messages: ChatMsg[], consumed: Set<number>) {
  const used = new Set(consumed);
  const keep: Pending[] = [];
  for (const p of pending) {
    const hit = messages.find((m) => m.mine && m.body === p.body && m.id > p.baseId && !used.has(m.id));
    if (hit) used.add(hit.id);
    else keep.push(p);
  }
  return { keep, used };
}

type Props = {
  messages: ChatMsg[];
  /** true nếu người xem là quản trị viên (tin của mình hiện với tên nổi bật) */
  viewerIsAdmin?: boolean;
  canSend?: boolean;
  closedNote?: string;
  /** gọi sau khi gửi xong để tải lại danh sách tin */
  onSent: () => void;
  height?: string;
};

export default function ChatBox({
  messages,
  viewerIsAdmin = false,
  canSend = true,
  closedNote = 'Phòng chat đã đóng.',
  onSent,
  height = '52vh',
}: Props) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const tempRef = useRef(0);
  const consumedRef = useRef<Set<number>>(new Set());
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  const shown = useMemo(
    () => matchPending(pending, messages, consumedRef.current).keep,
    [pending, messages]
  );

  // Dọn các tin tạm đã có bản thật
  useEffect(() => {
    if (shown.length === pending.length) return;
    consumedRef.current = matchPending(pending, messages, consumedRef.current).used;
    setPending(shown);
  }, [shown, pending, messages]);

  // Tự cuộn xuống cuối khi có tin mới (trừ khi người dùng đang đọc tin cũ)
  const total = messages.length + shown.length;
  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [total]);

  function dropPending(p: Pending, msg: string) {
    setPending((prev) => prev.filter((x) => x.tempId !== p.tempId));
    setError(msg);
    setText((t) => t || p.body);
  }

  async function post(p: Pending) {
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const r = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: p.body }),
        });
        if (r.status === 429 && attempt < 3) {
          await sleep(800);
          continue;
        }
        if (r.ok) {
          onSent();
          return;
        }
        const d = await r.json().catch(() => ({}));
        dropPending(p, d.error ?? 'Không gửi được tin nhắn.');
        return;
      }
    } catch {
      dropPending(p, 'Mất kết nối. Tin nhắn chưa được gửi.');
    }
  }

  function send(e: FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || !canSend) return;
    const p: Pending = {
      tempId: --tempRef.current,
      body,
      at: new Date().toISOString(),
      baseId: messages.reduce((m, x) => Math.max(m, x.id), 0),
    };
    // Hiện tin ngay lập tức, gửi lên máy chủ ở nền (gửi lần lượt để giữ đúng thứ tự)
    setPending((prev) => [...prev, p]);
    setText('');
    setError('');
    stickRef.current = true;
    chainRef.current = chainRef.current.then(() => post(p));
  }

  const all: (ChatMsg & { tempId?: number })[] = [
    ...messages,
    ...shown.map((p) => ({
      id: p.tempId,
      tempId: p.tempId,
      sender: viewerIsAdmin ? 'Quản trị viên' : 'Bạn',
      body: p.body,
      at: p.at,
      mine: true,
      isAdmin: viewerIsAdmin,
    })),
  ];

  return (
    <div className="flex flex-col">
      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="space-y-3 overflow-y-auto pr-1"
        style={{ height }}
      >
        {all.length === 0 && <p className="pt-10 text-center text-sm text-slate-500">Chưa có tin nhắn nào.</p>}
        {all.map((m) => {
          const isPending = m.tempId !== undefined;
          return (
            <div
              key={m.id}
              // Tin của mình hiện tức thì, không chạy hiệu ứng để khỏi nhấp nháy khi được xác nhận
              className={`flex flex-col ${m.mine ? 'items-end' : 'msg-in items-start'} ${isPending ? 'opacity-70' : ''}`}
            >
              <span className="mb-1 flex items-center gap-1.5 text-xs text-slate-400">
                {m.isAdmin ? (
                  <>
                    <span aria-hidden>👑</span>
                    <span className="admin-name text-sm">Quản trị viên</span>
                  </>
                ) : (
                  <span>{m.mine ? 'Bạn' : m.sender}</span>
                )}
                <span>· {clock(m.at)}</span>
              </span>
              <div
                className={`max-w-[80%] break-words rounded-2xl px-4 py-2 text-sm ${
                  m.isAdmin
                    ? `admin-bubble text-white ${m.mine ? 'rounded-br-sm' : 'rounded-bl-sm'}`
                    : m.mine
                      ? 'rounded-br-sm bg-electric text-white'
                      : 'rounded-bl-sm bg-slate-800'
                }`}
              >
                {m.body}
              </div>
            </div>
          );
        })}
      </div>
      <form onSubmit={send} className="mt-4 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={300}
          disabled={!canSend}
          placeholder={canSend ? 'Nhập tin nhắn…' : closedNote}
          className="input flex-1"
        />
        <button
          type="submit"
          disabled={!canSend || !text.trim()}
          onMouseDown={(e) => e.preventDefault()}
          className="btn-primary"
        >
          Gửi
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-rose-300">{error}</p>}
    </div>
  );
}
