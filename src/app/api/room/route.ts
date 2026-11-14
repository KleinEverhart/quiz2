import { NextResponse } from 'next/server';
import { adminSession, studentSession } from '@/lib/auth';
import { db } from '@/lib/db';
import { fail } from '@/lib/http';

type MsgRow = {
  id: number;
  sender_name: string;
  body: string;
  created_at: string;
  participant_id: string | null;
  participants: { role: string } | { role: string }[] | null;
};

export async function GET() {
  const s = studentSession() ?? adminSession();
  if (!s) return fail(401, 'UNAUTHORIZED');
  const isAdmin = s.role === 'admin';
  const sb = db();
  const now = Date.now();

  // Cập nhật "đang online" thưa thớt (tối đa mỗi 10 giây một lần). Quản trị viên không tính là thí sinh.
  if (!isAdmin) {
    await sb
      .from('participants')
      .update({ last_seen: new Date(now).toISOString() })
      .eq('id', s.pid)
      .lt('last_seen', new Date(now - 10_000).toISOString());
  }

  const [exam, people, msgs] = await Promise.all([
    sb.from('exam').select('status').eq('id', 1).single(),
    sb.from('participants').select('id, full_name, last_seen').eq('role', 'student').order('joined_at'),
    sb
      .from('chat_messages')
      .select('id, sender_name, body, created_at, participant_id, participants(role)')
      .order('id', { ascending: false })
      .limit(100),
  ]);

  const online = (iso: string) => new Date(iso).getTime() > now - 45_000;
  const list = people.data ?? [];
  // Tài khoản thí sinh đã bị xóa (sau RESET): buộc đăng nhập lại
  if (!isAdmin && !list.some((p) => p.id === s.pid)) return fail(401, 'UNAUTHORIZED');

  const rows = (msgs.data ?? []) as unknown as MsgRow[];
  const roleOf = (m: MsgRow) => (Array.isArray(m.participants) ? m.participants[0]?.role : m.participants?.role);

  return NextResponse.json({
    examStatus: exam.data?.status ?? 'WAITING',
    connected: list.filter((p) => online(p.last_seen)).length,
    // Chỉ trả về tên, không trả về MSSV hay mã định danh
    participants: list.map((p) => ({ name: p.full_name, online: online(p.last_seen), isMe: p.id === s.pid })),
    messages: rows.reverse().map((m) => ({
      id: m.id,
      sender: m.sender_name,
      body: m.body,
      at: m.created_at,
      mine: m.participant_id === s.pid,
      isAdmin: roleOf(m) === 'admin',
    })),
  });
}
