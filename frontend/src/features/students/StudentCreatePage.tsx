import { Stack, Title } from '@mantine/core';
import { useRef } from 'react';
import { useNavigate } from 'react-router';

import { useBelts, useCreateStudent } from '../../api/queries';
import type { StudentInput } from '../../api/types';
import { paths } from '../../app/navigation';
import { StudentForm } from './StudentForm';
import type { StudentsPageState } from './routeState';
import { LoadError, LoadingState } from './screenStates';
import { EMPTY_STUDENT_FORM } from './studentFormModel';
import { useRetryFocus } from './useRetryFocus';

const TITLE_ID = 'student-create-title';

/** § 6.2 "Novo aluno", for every profile; the API makes the caller the owner. */
export function StudentCreatePage() {
  const belts = useBelts();
  const create = useCreateStudent();
  const navigate = useNavigate();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const retryFocus = useRetryFocus([belts], titleRef);

  const handleSubmit = async (input: StudentInput) => {
    await create.mutateAsync(input);
    const state: StudentsPageState = { notice: 'created' };
    await navigate(paths.students, { state });
  };

  // A load error replaces the form only while there are no belts yet: a failed background
  // refetch (window focus) must not throw away what the user typed (§ 6.2).
  let content;
  if (belts.data === undefined && belts.isError) {
    content = (
      <LoadError
        title="Não foi possível carregar as faixas"
        error={belts.error}
        retrying={belts.isFetching}
        onRetry={() => void belts.refetch()}
        retryFocus={retryFocus}
      />
    );
  } else if (belts.data === undefined) {
    content = <LoadingState label="Carregando faixas…" />;
  } else {
    content = (
      <StudentForm
        belts={belts.data}
        initialValues={EMPTY_STUDENT_FORM}
        labelledBy={TITLE_ID}
        submitLabel="Cadastrar aluno"
        error={create.error}
        onSubmit={handleSubmit}
      />
    );
  }

  return (
    <Stack gap="md">
      <Title order={1} size="h2" id={TITLE_ID} ref={titleRef} tabIndex={-1}>
        Novo aluno
      </Title>
      {content}
    </Stack>
  );
}
