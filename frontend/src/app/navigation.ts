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
  examDay: '/dia-do-exame',
  belts: '/faixas',
  requirements: '/requisitos',
  events: '/eventos',
  academy: '/academia',
} as const;

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
