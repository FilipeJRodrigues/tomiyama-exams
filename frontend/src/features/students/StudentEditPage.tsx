import { Alert, Anchor, Button, Group, Modal, Stack, Text, Title } from '@mantine/core';
import { IconAlertCircle, IconTrash } from '@tabler/icons-react';
import { useRef, useState, type ReactNode, type Ref } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { ApiError, errorMessage } from '../../api/client';
import {
  useBelts,
  useDeleteStudent,
  useForgetStudent,
  useStudent,
  useUpdateStudent,
} from '../../api/queries';
import type { StudentInput, StudentView } from '../../api/types';
import { paths } from '../../app/navigation';
import { useAuth } from '../../auth/useAuth';
import { StudentExamHistory } from './StudentExamHistory';
import { StudentExamNotices } from './StudentExamNotices';
import { StudentForm } from './StudentForm';
import type { StudentsPageState } from './routeState';
import { LoadError, LoadingState } from './screenStates';
import { formValuesOf } from './studentFormModel';
import { useRetryFocus } from './useRetryFocus';

const TITLE_ID = 'student-edit-title';

/** `titleRef`: a "Tentar de novo" that ends in a 404 gives the focus to this title (§ 6.7). */
function NotFound({ titleRef }: { titleRef: Ref<HTMLHeadingElement> }) {
  return (
    <Stack gap="sm">
      <Title order={1} size="h2" ref={titleRef} tabIndex={-1}>
        Aluno não encontrado
      </Title>
      <Text>O aluno não existe ou não está entre os que você acompanha.</Text>
      <Text>
        <Anchor component={Link} to={paths.students}>
          Voltar para a lista de alunos
        </Anchor>
      </Text>
    </Stack>
  );
}

interface DeleteProps {
  student: StudentView;
}

/**
 * "Excluir aluno" with a confirmation dialog (Esc closes it). A student with exams is
 * refused by the API with 409 (RN018); the message stays in the dialog.
 */
function DeleteStudent({ student }: DeleteProps) {
  const [opened, setOpened] = useState(false);
  const remove = useDeleteStudent(student.id);
  const forgetStudent = useForgetStudent();
  const navigate = useNavigate();
  // Pending and deleted (while the page leaves) both lock the dialog; the ref also
  // covers a second click that arrives before the next render.
  const busy = useRef(false);
  const locked = remove.isPending || remove.isSuccess;

  const close = () => {
    if (busy.current) return;
    setOpened(false);
    remove.reset();
  };

  const confirm = () => {
    if (busy.current) return;
    busy.current = true;
    remove.mutate(undefined, {
      onSuccess: () => {
        const state: StudentsPageState = { notice: 'deleted' };
        // Forget the detail only after leaving, or this page would ask the API again.
        void Promise.resolve(navigate(paths.students, { state })).then(() => {
          forgetStudent(student.id);
        });
      },
      onError: () => {
        busy.current = false;
      },
    });
  };

  return (
    <>
      <Group>
        <Button
          variant="light"
          color="red"
          leftSection={<IconTrash size={18} aria-hidden />}
          onClick={() => {
            setOpened(true);
          }}
        >
          Excluir aluno
        </Button>
      </Group>
      <Modal
        opened={opened}
        onClose={close}
        title="Excluir aluno"
        centered
        closeButtonProps={{ 'aria-label': 'Fechar' }}
      >
        <Stack gap="md">
          <Text>Excluir {student.full_name}? Esta ação não pode ser desfeita.</Text>
          {remove.isError && (
            <Alert
              color="red"
              variant="light"
              role="alert"
              icon={<IconAlertCircle aria-hidden />}
              title="Não foi possível excluir"
            >
              {errorMessage(remove.error)}
            </Alert>
          )}
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={close} data-autofocus>
              Cancelar
            </Button>
            {/* red.9: white text at 4.5:1 or more, also on hover (§ 6.7). */}
            <Button color="red.9" loading={locked} onClick={confirm}>
              Excluir
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

/**
 * § 6.2 student form in edit mode (`/alunos/:id`), for the owner or an examiner. Examiners
 * also see the student's exam history below the form (RN018); a guardian never asks for it.
 * A guardian sees the exam notices above the form (RN019); an examiner never asks for them.
 */
export function StudentEditPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const student = useStudent(id);
  const belts = useBelts();
  const update = useUpdateStudent(id);
  const navigate = useNavigate();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const retryFocus = useRetryFocus([student, belts], titleRef);
  const isExaminer = user?.role === 'examiner';
  const isGuardian = user?.role === 'guardian';

  if (student.isError && student.error instanceof ApiError && student.error.status === 404) {
    return <NotFound titleRef={titleRef} />;
  }

  const handleSubmit = async (input: StudentInput) => {
    await update.mutateAsync(input);
    const state: StudentsPageState = { notice: 'updated' };
    await navigate(paths.students, { state });
  };

  // A load error replaces the form only while there is no data yet: a failed background
  // refetch (window focus) must not throw away what the user typed (§ 6.2).
  let content: ReactNode;
  if (student.data === undefined && student.isError) {
    content = (
      <LoadError
        title="Não foi possível carregar o aluno"
        error={student.error}
        retrying={student.isFetching}
        onRetry={() => void student.refetch()}
        retryFocus={retryFocus}
      />
    );
  } else if (belts.data === undefined && belts.isError) {
    content = (
      <LoadError
        title="Não foi possível carregar as faixas"
        error={belts.error}
        retrying={belts.isFetching}
        onRetry={() => void belts.refetch()}
        retryFocus={retryFocus}
      />
    );
  } else if (student.data === undefined || belts.data === undefined) {
    content = <LoadingState label="Carregando aluno…" />;
  } else {
    content = (
      <Stack gap="xl">
        {/* Keyed by id: the fields start from the loaded student and keep the user's edits. */}
        <StudentForm
          key={student.data.id}
          belts={belts.data}
          initialValues={formValuesOf(student.data)}
          labelledBy={TITLE_ID}
          submitLabel="Salvar alterações"
          error={update.error}
          onSubmit={handleSubmit}
        />
        <DeleteStudent student={student.data} />
      </Stack>
    );
  }

  const formShown = student.data !== undefined && belts.data !== undefined;

  return (
    <Stack gap="md">
      <Title order={1} size="h2" id={TITLE_ID} ref={titleRef} tabIndex={-1}>
        Editar aluno
      </Title>
      {/* Asked for and shown only with the form: never for a student that answers 404. */}
      {isGuardian && (
        <StudentExamNotices studentId={id} visible={formShown} fallbackFocus={titleRef} />
      )}
      {content}
      {/* Mounted while the student loads, so both are asked at once; shown with the form. */}
      {isExaminer && <StudentExamHistory studentId={id} visible={formShown} />}
    </Stack>
  );
}
