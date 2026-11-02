import {
  IconBuildingCommunity,
  IconCalendarEvent,
  IconChecklist,
  IconClipboardCheck,
  IconListNumbers,
  IconUsers,
  type Icon,
} from '@tabler/icons-react';

import type { Role } from '../auth/types';

export const paths = {
  login: '/entrar',
  signUp: '/cadastro',
  students: '/alunos',
  studentNew: '/alunos/novo',
  /** Route pattern of the student form in edit mode; build links with `studentPath`. */
  studentEdit: '/alunos/:id',
  examDay: '/dia-do-exame',
  belts: '/faixas',
  requirements: '/requisitos',
  events: '/eventos',
  academy: '/academia',
} as const;

/** `/alunos/{id}`: the student form in edit mode (the id is the API's opaque UUID). */
export function studentPath(id: string): string {
  return `${paths.students}/${encodeURIComponent(id)}`;
}

export interface NavItem {
  path: string;
  label: string;
  icon: Icon;
  roles: readonly Role[];
}

const everyone: readonly Role[] = ['examiner', 'guardian'];
const examiners: readonly Role[] = ['examiner'];

/** Menu items; examiner items stay hidden for guardians (§ 2). */
export const navItems: readonly NavItem[] = [
  { path: paths.students, label: 'Alunos', icon: IconUsers, roles: everyone },
  { path: paths.examDay, label: 'Dia do exame', icon: IconClipboardCheck, roles: examiners },
  { path: paths.belts, label: 'Faixas', icon: IconListNumbers, roles: examiners },
  { path: paths.requirements, label: 'Requisitos', icon: IconChecklist, roles: examiners },
  { path: paths.events, label: 'Eventos', icon: IconCalendarEvent, roles: examiners },
  { path: paths.academy, label: 'Academia', icon: IconBuildingCommunity, roles: examiners },
];

export function navItemsFor(role: Role): NavItem[] {
  return navItems.filter((item) => item.roles.includes(role));
}
