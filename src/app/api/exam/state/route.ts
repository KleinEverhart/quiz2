import { NextResponse } from 'next/server';
import { studentSession } from '@/lib/auth';
import { buildExamState } from '@/lib/examState';
import { fail } from '@/lib/http';

export async function GET() {
  const s = studentSession();
  if (!s) return fail(401, 'UNAUTHORIZED');
  const r = await buildExamState(s.pid);
  return NextResponse.json(r.body, { status: r.status });
}
