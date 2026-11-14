import { NextResponse } from 'next/server';
import { adminSession, studentSession } from '@/lib/auth';
import { db } from '@/lib/db';
import { fail } from '@/lib/http';
import { poke } from '@/lib/poke';

const ADMIN_NAME = 'Quản trị viên';

export async function POST(req: Request) {
  const s = adminSession() ?? studentSession();
  if (!s) return fail(401, 'UNAUTHORIZED');
  const isAdmin = s.role === 'admin';

  const body = await req.json().catch(() => null);
  const text = typeof body?.body === 'string' ? body.body.trim() : '';
  if (!text || text.length > 300) return fail(400, 'Tin nhắn cần từ 1 đến 300 ký tự.');

  const sb = db();
  const { data: exam } = await sb.from('exam').select('status').eq('id', 1).single();
  if (exam?.status !== 'WAITING') return fail(403, 'Phòng chat đã đóng.');

  // Tên người gửi lấy từ máy chủ, không tin theo dữ liệu từ trình duyệt
  let senderName = ADMIN_NAME;
  if (!isAdmin) {
    const { data: last } = await sb
      .from('chat_messages')
      .select('created_at')
      .eq('participant_id', s.pid)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (last && Date.now() - new Date(last.created_at).getTime() < 700) {
      return fail(429, 'Bạn gửi quá nhanh, vui lòng chờ một chút.');
    }
    const { data: me } = await sb.from('participants').select('full_name').eq('id', s.pid).maybeSingle();
    if (!me) return fail(401, 'UNAUTHORIZED');
    senderName = me.full_name;
  }

  const { data: ins, error } = await sb
    .from('chat_messages')
    .insert({ participant_id: s.pid, sender_name: senderName, body: text })
    .select('id, created_at')
    .single();
  if (error || !ins) return fail(500, 'Không gửi được tin nhắn.');

  await poke();
  return NextResponse.json({ ok: true, id: ins.id, at: ins.created_at });
}
