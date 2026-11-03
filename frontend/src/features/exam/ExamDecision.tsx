/**
 * Sensei decision (§ 6.4, RN008, RN008a, RN009, RN010): the decision area of the summary,
 * the confirmation dialog and the state they share.
 *
 * - The sensei sees Aprovar / Reprovar (in the phone bar, "Decidir" opens a panel with
 *   them); every decision goes through a dialog with an optional note.
 * - Marks still on their way finish first: the dialog says so and its confirm button
 *   waits, so the decision never overtakes a mark (which the API would then refuse with
 *   "Exame já decidido").
 * - The confirm button sends once: disabled with a loader while the request is on its way.
 * - Saved: the dialog closes, the screen turns read-only (the decided exam goes into the
 *   cache), the result is read out and the focus goes to "Decidido por …".
 * - "Exame já decidido": the dialog closes, the exam reloads and the message stays as a
 *   notice. Other refusals stay in the dialog with the API message.
 * - Closing the dialog gives the focus back to its opener or, when a refusal (sensei changed
 *   or removed) took Aprovar/Reprovar away, to the decision area (§ 6.7).
 * - Deleted student (RN018): no Aprovar/Reprovar, a notice says the exam cannot be decided.
 */
import {
  Alert,
  Anchor,
  Button,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  Textarea,
  VisuallyHidden,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconCircleCheck,
  IconCircleX,
  IconGavel,
  IconUserExclamation,
  IconUserOff,
} from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';

import { errorMessage } from '../../api/client';
import { useSettings } from '../../api/queries';
import type { Belt, DecisionResult, ExamSheet, ExamView, Examiner } from '../../api/types';
import { paths } from '../../app/navigation';
import { useAuth } from '../../auth/useAuth';
import { REQUIREMENT_KIND_LABELS } from '../../lib/labels';
import { LoadError } from '../students/screenStates';
import {
  NOTES_MAX_LENGTH,
  confirmationText,
  decidedByText,
  decisionButtonLabel,
  decisionRole,
  decisionTitle,
  deciderName,
  senseiOnlyText,
} from './decisionModel';
import { REQUIREMENT_KINDS, percentLabel } from './examModel';
import { TOUCH_TARGET } from './touch';
import type { DecisionFlow, DecisionLayout } from './useDecisionFlow';

export type { DecisionLayout } from './useDecisionFlow';

interface DecidedProps {
  exam: ExamView;
  examiners: Examiner[] | undefined;
  flow: DecisionFlow;
  takesFocus: boolean;
}

function Decided({ exam, examiners, flow, takesFocus }: DecidedProps) {
  const settings = useSettings();
  const ref = useRef<HTMLDivElement>(null);
  const { focusDecided, decidedFocused } = flow;
  useEffect(() => {
    if (!takesFocus || !focusDecided) return;
    ref.current?.focus();
    decidedFocused();
  }, [takesFocus, focusDecided, decidedFocused]);
  const name = exam.decided_by_id
    ? deciderName(exam.decided_by_id, examiners, settings.data?.sensei)
    : undefined;
  const namesLoaded = examiners !== undefined && !settings.isPending;
  return (
    <Stack gap={2} data-slot="decision" ref={ref} tabIndex={-1}>
      <Group gap={6} wrap="nowrap" align="flex-start">
        <IconGavel size={18} aria-hidden style={{ flex: 'none', marginTop: 2 }} />
        <Text size="sm" fw={500}>
          {decidedByText(name, namesLoaded)}
        </Text>
      </Group>
      {exam.notes && (
        <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
          {`Observação: ${exam.notes}`}
        </Text>
      )}
    </Stack>
  );
}

function DecideButtons({ flow }: { flow: DecisionFlow }) {
  return (
    <Group gap="sm" grow role="group" aria-label="Decisão do sensei">
      <Button
        variant="light"
        color="green"
        leftSection={<IconCircleCheck size={18} aria-hidden />}
        style={TOUCH_TARGET}
        onClick={() => {
          flow.ask('APPROVED');
        }}
      >
        Aprovar
      </Button>
      <Button
        variant="light"
        color="red"
        leftSection={<IconCircleX size={18} aria-hidden />}
        style={TOUCH_TARGET}
        onClick={() => {
          flow.ask('FAILED');
        }}
      >
        Reprovar
      </Button>
    </Group>
  );
}

function SenseiMissing({ inactive }: { inactive: boolean }) {
  return (
    <Alert
      color="orange"
      variant="light"
      role="note"
      icon={<IconUserExclamation aria-hidden />}
      title={inactive ? 'Sensei inativo' : 'Sem sensei definido'}
      p="xs"
    >
      <Stack gap={4} align="flex-start">
        <Text size="sm">
          {inactive
            ? 'O sensei escolhido não está mais ativo. Escolha outro para decidir os exames.'
            : 'Defina o sensei para decidir os exames.'}
        </Text>
        <Anchor component={Link} to={paths.academy} size="sm">
          Abrir configurações da academia
        </Anchor>
      </Stack>
    </Alert>
  );
}

/** Same look as "A decisão é do sensei …"; the page already has the deleted-student note. */
function StudentDeleted() {
  return (
    <Group gap={6} wrap="nowrap" align="flex-start">
      <IconUserOff size={18} aria-hidden style={{ flex: 'none', marginTop: 2 }} />
      <Text size="sm" fw={500}>
        O aluno foi excluído, então o exame não pode ser decidido.
      </Text>
    </Group>
  );
}

interface InProgressProps {
  flow: DecisionFlow;
  layout: DecisionLayout;
  studentDeleted: boolean;
}

/** While the exam is in progress: who decides, from the settings (RN008). */
function InProgress({ flow, layout, studentDeleted }: InProgressProps) {
  const settings = useSettings();
  const { user } = useAuth();
  if (studentDeleted) return <StudentDeleted />;
  if (settings.data === undefined) {
    if (settings.isError) {
      return (
        <LoadError
          title="Não foi possível saber quem é o sensei"
          error={settings.error}
          retrying={settings.isFetching}
          onRetry={() => void settings.refetch()}
        />
      );
    }
    return (
      <Group gap="xs" wrap="nowrap">
        <Loader size="xs" aria-hidden />
        <Text size="sm" c="dimmed">
          Carregando quem decide…
        </Text>
      </Group>
    );
  }
  const role = decisionRole(settings.data, user?.id);
  if (role.kind === 'noSensei' || role.kind === 'inactiveSensei') {
    return <SenseiMissing inactive={role.kind === 'inactiveSensei'} />;
  }
  if (role.kind === 'other') {
    return (
      <Group gap={6} wrap="nowrap" align="flex-start">
        <IconGavel size={18} aria-hidden style={{ flex: 'none', marginTop: 2 }} />
        <Text size="sm" fw={500}>
          {senseiOnlyText(role.senseiName)}
        </Text>
      </Group>
    );
  }
  if (layout === 'bar') {
    return (
      <Button
        fullWidth
        leftSection={<IconGavel size={18} aria-hidden />}
        style={TOUCH_TARGET}
        aria-haspopup="dialog"
        aria-expanded={flow.panelOpened}
        onClick={flow.openPanel}
      >
        Decidir
      </Button>
    );
  }
  return <DecideButtons flow={flow} />;
}

interface DecisionAreaProps {
  exam: ExamView;
  examiners: Examiner[] | undefined;
  flow: DecisionFlow;
  layout: DecisionLayout;
  /** The student's record was deleted (RN018): the exam cannot be decided. */
  studentDeleted: boolean;
}

/**
 * Decision area of the summary (§ 6.4). The certificate comes in card #27. It takes the focus
 * when the button that opened the dialog or the panel is gone (§ 6.7).
 */
export function DecisionArea({ exam, examiners, flow, layout, studentDeleted }: DecisionAreaProps) {
  const decided = exam.status !== 'IN_PROGRESS';
  return (
    <Stack gap="xs" ref={flow.areaRef[layout]} tabIndex={-1} data-decision-area={layout}>
      {flow.notice && layout !== 'panel' && (
        <Alert
          color="red"
          variant="light"
          role="alert"
          icon={<IconAlertCircle aria-hidden />}
          withCloseButton
          closeButtonLabel="Fechar aviso"
          onClose={flow.dismissNotice}
          p="xs"
        >
          {flow.notice}
        </Alert>
      )}
      {decided ? (
        <Decided exam={exam} examiners={examiners} flow={flow} takesFocus={layout !== 'panel'} />
      ) : (
        <InProgress flow={flow} layout={layout} studentDeleted={studentDeleted} />
      )}
    </Stack>
  );
}

interface DecisionDialogProps {
  flow: DecisionFlow;
  sheet: ExamSheet;
  belts: Belt[] | undefined;
  /** No mark on its way. */
  settled: boolean;
}

/**
 * Confirmation of the decision (§ 6.4): the question, the percentages as support (RN008
 * does not depend on them), an optional note (≤ 500) and Cancelar / Aprovar|Reprovar.
 * `Esc` and Cancelar close it, except while the decision is on its way.
 */
export function DecisionDialog({ flow, sheet, belts, settled }: DecisionDialogProps) {
  const { asking } = flow;
  const [notes, setNotes] = useState('');
  // The texts stay while the dialog fades out; a new opening starts with an empty note.
  const [previous, setPrevious] = useState(asking);
  const [shown, setShown] = useState<DecisionResult>(asking ?? 'APPROVED');
  if (asking !== previous) {
    setPrevious(asking);
    if (asking !== null) {
      setShown(asking);
      if (previous === null) setNotes('');
    }
  }
  const result = asking ?? shown;

  const approve = result === 'APPROVED';
  const notesLength = Array.from(notes).length;
  const notesTooLong = notesLength > NOTES_MAX_LENGTH;
  const percents = REQUIREMENT_KINDS.map(
    (kind) => `${REQUIREMENT_KIND_LABELS[kind]} ${percentLabel(sheet.summary[kind])}`,
  ).join(' · ');

  return (
    <Modal
      opened={asking !== null}
      onClose={flow.cancel}
      title={decisionTitle(result)}
      centered
      zIndex={300}
      // The opener may be gone after a refusal: the flow gives the focus back (§ 6.7).
      returnFocus={false}
      onExitTransitionEnd={flow.dialogClosed}
      closeButtonProps={{ 'aria-label': 'Fechar' }}
    >
      <Stack gap="md">
        <Text>{confirmationText(result, sheet, belts)}</Text>
        <Text size="sm" c="dimmed">
          {percents}
        </Text>
        <Textarea
          label="Observação (opcional)"
          description={`${notesLength} de ${NOTES_MAX_LENGTH} caracteres`}
          value={notes}
          onChange={(event) => {
            setNotes(event.currentTarget.value);
          }}
          maxLength={NOTES_MAX_LENGTH}
          rows={3}
          disabled={flow.sending}
          error={notesTooLong ? `Observação: máximo de ${NOTES_MAX_LENGTH} caracteres` : undefined}
          data-autofocus
        />
        {!settled && (
          <Group gap="xs" wrap="nowrap" role="status">
            <Loader size="xs" aria-hidden />
            <Text size="sm">Aguardando as marcações serem salvas…</Text>
          </Group>
        )}
        {flow.error !== null && (
          <Alert
            color="red"
            variant="light"
            role="alert"
            icon={<IconAlertCircle aria-hidden />}
            title="Não foi possível decidir"
          >
            {errorMessage(flow.error)}
          </Alert>
        )}
        <VisuallyHidden role="status">{flow.sending ? 'Enviando a decisão…' : ''}</VisuallyHidden>
        <Group justify="flex-end" gap="sm">
          <Button
            variant="default"
            style={TOUCH_TARGET}
            disabled={flow.sending}
            onClick={flow.cancel}
          >
            Cancelar
          </Button>
          {/* blue.8 (primary) and red.9: white text at 4.5:1 or more (§ 6.7). */}
          <Button
            color={approve ? undefined : 'red.9'}
            style={TOUCH_TARGET}
            loading={flow.sending}
            disabled={!settled || notesTooLong}
            onClick={() => {
              flow.confirm(notes);
            }}
          >
            {decisionButtonLabel(result)}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
