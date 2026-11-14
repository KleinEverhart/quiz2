'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import ChatBox, { type ChatMsg } from '@/components/ChatBox';
import { onPoke } from '@/lib/realtime';
import { RULES } from '@/lib/rules';

type Room = {
  examStatus: 'WAITING' | 'RUNNING' | 'ENDED';
  connected: number;
  participants: { name: string; online: boolean; isMe: boolean }[];
  messages: ChatMsg[];
};

export default function RoomPage() {
  const router = useRouter();
  const [room, setRoom] = useState<Room | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/room', { cache: 'no-store' });
      if (r.status === 401) return router.replace('/');
      if (!r.ok) return;
      const d: Room = await r.json();
      if (d.examStatus !== 'WAITING') return router.replace(d.examStatus === 'RUNNING' ? '/exam' : '/result');
      setRoom(d);
    } catch {
      /* giữ dữ liệu cũ, thử lại ở lần sau */
    }
  }, [router]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 4000);
    const off = onPoke(load);
    return () => {
      clearInterval(timer);
      off();
    };
  }, [load]);

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/');
  }

  return (
    <main className="min-h-screen px-4 py-6 md:px-8">
      <header className="mx-auto mb-6 flex max-w-6xl flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs tracking-[0.3em] text-sky-300/80">PHILOSOPHY EXAM</p>
          <h1 className="text-2xl font-bold md:text-3xl">WAITING ROOM</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-4 py-1.5 text-sm text-amber-200">
            Đang chờ quản trị viên bắt đầu kỳ thi
          </span>
          <button onClick={logout} className="btn-ghost">Thoát</button>
        </div>
      </header>

      <section className="glass msg-in mx-auto mb-6 max-w-6xl p-5">
        <h2 className="mb-3 font-semibold text-amber-200">LUẬT CHƠI</h2>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-slate-300">
          {RULES.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ol>
      </section>

      {!room ? (
        <p className="text-center text-slate-400">Đang tải phòng chờ…</p>
      ) : (
        <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[300px_1fr]">
          <section className="glass p-5">
            <div className="mb-4 flex items-end justify-between">
              <h2 className="font-semibold">Thí sinh trong phòng</h2>
              <span className="text-3xl font-bold tabular-nums text-sky-300">{room.connected}</span>
            </div>
            <ul className="max-h-[56vh] space-y-2 overflow-y-auto pr-1">
              {room.participants.map((p, i) => (
                <li key={i} className="flex items-center gap-3 rounded-xl bg-slate-900/50 px-3 py-2">
                  <span
                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                      p.online ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]' : 'bg-slate-600'
                    }`}
                  />
                  <span className="truncate">
                    {p.name}
                    {p.isMe && <span className="ml-2 text-xs text-sky-300">(bạn)</span>}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="glass flex flex-col p-5">
            <h2 className="mb-4 font-semibold">Trò chuyện</h2>
            <ChatBox messages={room.messages} onSent={load} />
          </section>
        </div>
      )}
    </main>
  );
}
