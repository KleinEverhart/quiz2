'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { onPoke } from '@/lib/realtime';
import { FEEDBACK_MS, SECONDS_PER_QUESTION } from '@/lib/rules';

type Feedback = { selected: string | null; correct: string; isCorrect: boolean; points: number };
type ExamState =
  | { phase: 'WAITING' | 'NO_ATTEMPT' | 'COMPLETED' | 'DISQUALIFIED' | 'ENDED' | 'VOID' }
  | {
      phase: 'EXAM';
      position: number;
      total: number;
      question: string;
      options: { key: string; text: string }[];
      remainingMs: number;
      feedback: Feedback | null;
      warnings: number;
    };

function optionClass(key: string, fb: Feedback | null, pending: string | null): string {
  const base =
    'flex w-full items-center rounded-2xl border px-4 py-4 text-left transition-[transform,background-color,border-color,box-shadow,opacity] duration-200 disabled:cursor-not-allowed ';
  if (!fb) {
    // Vừa bấm: tô sáng ngay đáp án đã chọn, chờ máy chủ xác nhận
    if (pending) {
      return base + (key === pending ? 'border-sky-400 bg-sky-500/20' : 'border-slate-700/50 bg-slate-900/40 opacity-60');
    }
    return (
      base +
      'border-slate-600/60 bg-slate-900/60 active:scale-[0.99] [@media(hover:hover)]:hover:-translate-y-0.5 [@media(hover:hover)]:hover:border-sky-400 [@media(hover:hover)]:hover:bg-slate-800/80'
    );
  }
  if (key === fb.correct) {
    return base + 'border-emerald-400 bg-emerald-500/20 text-emerald-50 shadow-[0_0_25px_-5px_rgba(52,211,153,0.6)]';
  }
  if (key === fb.selected) return base + 'border-rose-500 bg-rose-500/20 text-rose-50';
  return base + 'border-slate-700/50 bg-slate-900/40 opacity-50';
}

export default function ExamPage() {
  const router = useRouter();
  const [st, setSt] = useState<ExamState | null>(null);
  const [deadline, setDeadline] = useState(0);
  const [, setTick] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [who, setWho] = useState<{ fullName: string; mssv: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [offline, setOffline] = useState(false);
  const busyRef = useRef(false);
  const phaseRef = useRef<string | null>(null);
  const timeoutPosRef = useRef<number | null>(null);
  const answerRttRef = useRef(0); // độ trễ mạng đo được ở lần trả lời gần nhất
  const seqRef = useRef(0); // chỉ nhận phản hồi của yêu cầu mới nhất, tránh dữ liệu cũ ghi đè
  const deadlineRef = useRef({ pos: -1, at: 0 });

  const applyState = useCallback(
    (d: ExamState, rtt = 0) => {
      if (d.phase === 'WAITING') {
        router.replace('/room');
        return;
      }
      setSt(d);
      if (d.phase !== 'EXAM') {
        router.replace('/result');
        return;
      }
      // Giữ đồng hồ ổn định: chỉ chỉnh lại khi sang câu mới hoặc lệch quá 1,5 giây so với máy chủ
      const candidate = Date.now() + d.remainingMs - rtt / 2;
      const cur = deadlineRef.current;
      if (cur.pos !== d.position || Math.abs(cur.at - candidate) > 1500) {
        deadlineRef.current = { pos: d.position, at: candidate };
        setDeadline(candidate);
      }
    },
    [router]
  );

  const fetchState = useCallback(async () => {
    const my = ++seqRef.current;
    try {
      const t0 = Date.now();
      const r = await fetch('/api/exam/state', { cache: 'no-store' });
      if (r.status === 401) {
        router.replace('/');
        return;
      }
      const d = (await r.json()) as ExamState;
      if (my !== seqRef.current) return;
      setOffline(false);
      applyState(d, Date.now() - t0);
    } catch {
      setOffline(true);
    }
  }, [router, applyState]);

  // Kiểm tra phiên, tải trạng thái ban đầu, và làm mới định kỳ (dự phòng cho realtime)
  useEffect(() => {
    fetch('/api/session', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (!d.authenticated) return router.replace('/');
        if (d.role === 'student') setWho({ fullName: d.fullName, mssv: d.mssv });
        if (d.redirect !== '/exam') router.replace(d.redirect);
      })
      .catch(() => {});
    fetchState();
    // Realtime báo ngay khi admin dừng thi / reset; vòng lặp 6 giây chỉ là dự phòng
    const off = onPoke(fetchState);
    const poll = setInterval(fetchState, 6000);
    return () => {
      clearInterval(poll);
      off();
    };
  }, [fetchState, router]);

  useEffect(() => {
    phaseRef.current = st?.phase ?? null;
  }, [st]);

  // Sau khi xem đúng/sai, tự chuyển sang câu tiếp theo
  const feedbackPos = st?.phase === 'EXAM' && st.feedback ? st.position : null;
  useEffect(() => {
    if (feedbackPos === null) return;
    const t = setTimeout(async () => {
      try {
        const r = await fetch('/api/exam/next', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ position: feedbackPos }),
        });
        const d = await r.json();
        if (d?.state) {
          seqRef.current++;
          applyState(d.state as ExamState);
          // Nếu máy chủ chưa kịp chuyển câu thì hỏi lại ngay sau chốc lát
          if (d.state.phase === 'EXAM' && d.state.feedback && d.state.position === feedbackPos) {
            setTimeout(fetchState, 800);
          }
          return;
        }
      } catch {
        /* rơi xuống fetchState bên dưới */
      }
      fetchState();
    }, Math.max(300, FEEDBACK_MS - answerRttRef.current));
    return () => clearTimeout(t);
  }, [feedbackPos, fetchState, applyState]);

  // Khi hết 30 giây, nhờ máy chủ chuyển câu (máy chủ là nguồn thời gian chính thức)
  const remaining = st?.phase === 'EXAM' && !st.feedback ? Math.max(0, deadline - Date.now()) : null;

  // Đồng hồ chỉ chạy khi đang có câu chờ trả lời (nhịp 100ms cho mượt)
  const ticking = st?.phase === 'EXAM' && !st.feedback;
  useEffect(() => {
    if (!ticking) return;
    const tick = setInterval(() => setTick((n) => n + 1), 100);
    return () => clearInterval(tick);
  }, [ticking]);
  useEffect(() => {
    if (st?.phase !== 'EXAM' || st.feedback || remaining !== 0) return;
    if (timeoutPosRef.current === st.position) return;
    timeoutPosRef.current = st.position;
    setTimeout(fetchState, 400);
  }, [remaining, st, fetchState]);

  // Theo dõi hành vi rời trang. Mỗi lần rời chỉ gửi một sự kiện.
  useEffect(() => {
    let away = false;
    let offlineAt = 0;

    const send = (kind: string) =>
      fetch('/api/exam/violation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
        keepalive: true,
      })
        .then((r) => r.json())
        .then((d) => {
          if (d.action === 'WARNING') {
            setNotice('Cảnh cáo: bạn vừa rời khỏi trang thi. Vi phạm thêm một lần nữa sẽ bị loại.');
          }
          if (d.action === 'DISQUALIFIED') fetchState();
        })
        .catch(() => {});

    const report = (kind: string) => {
      if (away || phaseRef.current !== 'EXAM') return;
      away = true;
      send(kind);
    };
    const onVisibility = () => {
      if (document.hidden) report('tab_hidden');
      else away = false;
    };
    const onBlur = () => report('window_blur');
    const onFocus = () => {
      if (!document.hidden) away = false;
    };
    const onPageHide = () => {
      if (phaseRef.current === 'EXAM') {
        navigator.sendBeacon(
          '/api/exam/violation',
          new Blob([JSON.stringify({ kind: 'page_leave' })], { type: 'application/json' })
        );
      }
    };
    const onOffline = () => {
      offlineAt = Date.now();
      setOffline(true);
    };
    const onOnline = () => {
      setOffline(false);
      if (offlineAt && phaseRef.current === 'EXAM') {
        send('connection_lost');
        offlineAt = 0;
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, [fetchState]);

  async function answer(choice: string) {
    if (!st || st.phase !== 'EXAM' || st.feedback || busyRef.current) return;
    const pos = st.position;
    busyRef.current = true;
    setPending(choice);
    try {
      const t0 = Date.now();
      const r = await fetch('/api/exam/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: pos, choice }),
      });
      answerRttRef.current = Math.min(600, Date.now() - t0);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice(d.error ?? 'Không ghi nhận được đáp án.');
      } else {
        // Hiện ĐÚNG/SAI ngay từ phản hồi, không chờ tải lại trạng thái
        seqRef.current++;
        setNotice('');
        setSt((prev) =>
          prev && prev.phase === 'EXAM' && prev.position === pos
            ? {
                ...prev,
                remainingMs: 0,
                feedback: { selected: d.selected, correct: d.correct, isCorrect: d.isCorrect, points: d.points },
              }
            : prev
        );
      }
    } catch {
      setNotice('Mất kết nối, đáp án chưa được ghi nhận. Vui lòng chọn lại.');
    } finally {
      busyRef.current = false;
      setPending(null);
      fetchState();
    }
  }

  if (!st || st.phase !== 'EXAM') {
    return (
      <main className="grid min-h-screen place-items-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-sky-400 border-t-transparent" />
          <p className="text-slate-300">{offline ? 'Mất kết nối, đang thử lại…' : 'Đang tải bài thi…'}</p>
        </div>
      </main>
    );
  }

  const fb = st.feedback;
  const secs = Math.min(SECONDS_PER_QUESTION, Math.ceil((remaining ?? 0) / 1000));
  const frac = remaining === null ? 0 : Math.min(1, remaining / (SECONDS_PER_QUESTION * 1000));
  const danger = remaining !== null && remaining <= 10_000;
  const timedOut = remaining === 0 && !fb;
  const pct = ((st.position - 1) / st.total) * 100;

  return (
    <main className="mx-auto min-h-screen max-w-4xl px-4 py-6">
      <header className="glass mb-4 flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-sky-300/80">PHILOSOPHY EXAM</p>
          <p className="font-semibold">
            {who?.fullName ?? '…'}{' '}
            <span className="text-sm font-normal text-slate-400">· MSSV {who?.mssv ?? '…'}</span>
          </p>
        </div>
        <div className="text-sm text-slate-300">
          Câu <b className="text-white">{st.position}</b> / {st.total}
        </div>
      </header>

      <div className="mb-5 h-2.5 overflow-hidden rounded-full bg-slate-800">
        <div
          className="h-full rounded-full bg-gradient-to-r from-electric to-cyan-400 transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>

      {notice && (
        <div className="mb-4 rounded-xl border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {notice}
        </div>
      )}
      {st.warnings > 0 && (
        <div className="mb-4 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
          Bạn đã bị cảnh cáo {st.warnings} lần. Vi phạm thêm sẽ bị loại khỏi kỳ thi.
        </div>
      )}
      {offline && (
        <div className="mb-4 rounded-xl border border-slate-600 bg-slate-800/60 px-4 py-3 text-sm text-slate-300">
          Mất kết nối. Thời gian vẫn được tính theo máy chủ, hãy kiểm tra mạng.
        </div>
      )}

      <section key={st.position} className="glass msg-in p-6 md:p-8">
        <div className="mb-5 h-1.5 overflow-hidden rounded-full bg-slate-800/80">
          <div
            className={`h-full origin-left rounded-full transition-[transform,opacity] duration-150 ease-linear ${
              danger ? 'bg-rose-500' : 'bg-sky-400'
            } ${fb ? 'opacity-0' : ''}`}
            style={{ transform: `scaleX(${frac})` }}
          />
        </div>
        <div className="mb-6 flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold leading-relaxed md:text-xl">{st.question}</h2>
          <div
            className={`grid h-20 w-20 shrink-0 place-items-center rounded-full border-4 text-2xl font-bold tabular-nums transition-colors ${
              danger ? 'timer-danger border-rose-500 text-rose-300' : 'border-sky-400 text-sky-200'
            }`}
          >
            {fb ? '—' : secs}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          {st.options.map((o) => (
            <button
              key={o.key}
              disabled={!!fb || timedOut || pending !== null}
              onClick={() => answer(o.key)}
              className={optionClass(o.key, fb, pending)}
            >
              <span className="mr-3 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-800 text-sm font-bold">
                {o.key}
              </span>
              <span className="text-left">{o.text}</span>
            </button>
          ))}
        </div>

        {fb && (
          <div
            className={`msg-in mt-6 rounded-xl px-4 py-3 text-center text-lg font-extrabold tracking-widest ${
              fb.isCorrect ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'
            }`}
          >
            {fb.isCorrect ? `ĐÚNG · +${fb.points} điểm` : 'SAI · 0 điểm'}
          </div>
        )}
        {timedOut && (
          <p className="mt-6 text-center text-sm text-amber-300">Hết giờ, đang chuyển sang câu tiếp theo…</p>
        )}
        {!fb && !timedOut && (
          <p className="mt-6 text-center text-xs text-slate-500">
            Mỗi câu {SECONDS_PER_QUESTION} giây. Trả lời đúng được điểm bằng số giây còn lại. Đáp án đã chọn không thể thay đổi.
          </p>
        )}
      </section>
    </main>
  );
}
