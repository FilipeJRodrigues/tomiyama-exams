/**
 * Cells shared by the students list (§ 6.2) and the exam day list (§ 6.3): the belt with
 * its mini belt, the eligibility status and the label/value pair of the cards.
 */
import { Group, Text } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck, IconCircleMinus } from '@tabler/icons-react';
import type { ReactNode } from 'react';

import type { Belt, StudentView } from '../../api/types';
import { NamedBelt } from '../belts/BeltShape';
import { beltLabel, type StudentStatus } from './studentText';

/** The current belt (and stripes) of the student, with the mini belt before the name. */
export function BeltCell({ student, belt }: { student: StudentView; belt: Belt | undefined }) {
  return <NamedBelt belt={belt}>{beltLabel(student.current_belt_name, student.stripes)}</NamedBelt>;
}

const STATUS_ICONS = {
  inactive: IconCircleMinus,
  eligible: IconCircleCheck,
  blocked: IconAlertTriangle,
} as const;

/** The state is always written out; the icon and the red only reinforce it (§ 6.7). */
export function StatusText({ status }: { status: StudentStatus }) {
  const Icon = STATUS_ICONS[status.kind];
  const color =
    status.kind === 'blocked'
      ? 'var(--mantine-color-error)'
      : status.kind === 'inactive'
        ? 'var(--mantine-color-dimmed)'
        : undefined;
  const iconColor = status.kind === 'eligible' ? 'var(--mantine-color-green-light-color)' : color;
  return (
    <Group gap={6} wrap="nowrap" align="flex-start" data-status={status.kind}>
      <Icon size={18} aria-hidden style={{ flex: 'none', marginTop: 1, color: iconColor }} />
      {/* Long block reasons wrap instead of widening the column. */}
      <Text
        component="span"
        size="sm"
        c={color}
        fw={status.kind === 'blocked' ? 500 : undefined}
        miw={0}
        style={{ overflowWrap: 'anywhere' }}
      >
        {status.label}
      </Text>
    </Group>
  );
}

/** A label/value pair of a card (`dt`/`dd`). */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Text component="dt" size="sm" c="dimmed">
        {label}
      </Text>
      <Text component="dd" size="sm" m={0}>
        {children}
      </Text>
    </div>
  );
}
