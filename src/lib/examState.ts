import { attemptIdFor } from './attempt';
import { db } from './db';
import { QUESTION_COUNT, SECONDS_PER_QUESTION } from './rules';

const LETTERS = ['A', 'B', 'C', 'D'];
const SECONDS_MS = SECONDS_PER_QUESTION * 1000;

export type StateResult = { status: number; body: Record<string, unknown> };

const ok = (body: Record<string, unknown>): StateResult => ({ status: 200, body });

/** Trạng thái bài thi của một thí sinh. Dùng chung cho /api/exam/state và /api/exam/next. */
export async function buildExamState(pid: string): Promise<StateResult> {
  const sb = db();

  // Ba truy vấn độc lập chạy song song để giảm độ trễ
  const [meRes, examRes, attId] = await Promise.all([
    sb.from('participants').select('voided_reason').eq('id', pid).maybeSingle(),
    sb.from('exam').select('status').eq('id', 1).single(),
    attemptIdFor(pid),
  ]);

  if (!meRes.data) return { status: 401, body: { error: 'UNAUTHORIZED' } };
  if (meRes.data.voided_reason) return ok({ phase: 'VOID' });

  const exam = examRes.data;
  if (exam?.status === 'WAITING') return ok({ phase: 'WAITING' });
  if (exam?.status === 'ENDED') return ok({ phase: 'ENDED' });
  if (!attId) return ok({ phase: 'NO_ATTEMPT' });

  await sb.rpc('settle_attempt', { p_attempt: attId });

  const [aRes, vRes] = await Promise.all([
    sb.from('attempts').select('id, status, current_position, question_started_at').eq('id', attId).single(),
    sb.from('violations').select('id', { count: 'exact', head: true }).eq('participant_id', pid).neq('action', 'INFO'),
  ]);
  const a = aRes.data;
  if (!a) return { status: 404, body: { error: 'NOT_FOUND' } };
  if (a.status === 'COMPLETED') return ok({ phase: 'COMPLETED' });
  if (a.status === 'DISQUALIFIED') return ok({ phase: 'DISQUALIFIED' });

  const { data: aq } = await sb
    .from('attempt_questions')
    .select('option_order, selected_display, is_correct, points, answered_at, questions(question, options, answer)')
    .eq('attempt_id', a.id)
    .eq('position', a.current_position)
    .single();
  if (!aq) return { status: 500, body: { error: 'Thiếu dữ liệu câu hỏi.' } };

  // Đáp án đúng chỉ được gửi sau khi thí sinh đã trả lời câu này
  const q = aq.questions as unknown as { question: string; options: { key: string; text: string }[]; answer: string };
  const order = aq.option_order as string[];
  const options = order.map((orig, i) => ({
    key: LETTERS[i],
    text: q.options.find((o) => o.key === orig)?.text ?? '',
  }));
  const answered = aq.answered_at !== null;
  const remainingMs = answered
    ? 0
    : Math.max(0, new Date(a.question_started_at!).getTime() + SECONDS_MS - Date.now());

  return ok({
    phase: 'EXAM',
    position: a.current_position,
    total: QUESTION_COUNT,
    question: q.question,
    options,
    remainingMs,
    feedback: answered
      ? {
          selected: aq.selected_display,
          correct: LETTERS[order.indexOf(q.answer)],
          isCorrect: aq.is_correct,
          points: aq.points,
        }
      : null,
    warnings: vRes.count ?? 0,
  });
}
