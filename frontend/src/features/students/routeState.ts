/**
 * Router state the student form leaves for the list after saving. Only a fixed key travels
 * (never the student name), and the list clears it once shown (LGPD).
 */
export type StudentNotice = 'created' | 'updated' | 'deleted';

export interface StudentsPageState {
  notice: StudentNotice;
}

export const NOTICE_TEXTS: Record<StudentNotice, string> = {
  created: 'Aluno cadastrado.',
  updated: 'Alterações salvas.',
  deleted: 'Aluno excluído.',
};

export function noticeOf(state: unknown): StudentNotice | null {
  if (typeof state !== 'object' || state === null || !('notice' in state)) return null;
  const { notice } = state;
  return notice === 'created' || notice === 'updated' || notice === 'deleted' ? notice : null;
}
