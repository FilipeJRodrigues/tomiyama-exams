import { Alert, Stack, Text, Title } from '@mantine/core';
import { IconCircleCheck } from '@tabler/icons-react';
import { useRef, useState, type ReactNode } from 'react';

import { useExaminers, useSettings, useUpdateSettings } from '../../api/queries';
import type { AcademySettings, AcademySettingsInput } from '../../api/types';
import { useAuth } from '../../auth/useAuth';
import { focusIfLost } from '../exam/focus';
import { LoadError, LoadingState } from '../students/screenStates';
import { useRetryFocus } from '../students/useRetryFocus';
import { AcademyForm } from './AcademyForm';
import { LogosSection } from './LogosSection';
import { isFirstUse } from './academyFormModel';

const TITLE_ID = 'academy-title';
const DATA_TITLE_ID = 'academy-data-title';

/**
 * § 6.6 academy screen (examiners): the academy data (`GET`/`PUT /settings`), with the
 * sensei chosen among the active examiners (`GET /examiners`) by the admin master only, and
 * below it the two logos (`/settings/logos/{slot}`, RN012), loaded and saved on their own.
 * The certificate signatures come later.
 */
export function AcademyPage() {
  const { user } = useAuth();
  const isMaster = user?.isMaster ?? false;
  const settings = useSettings();
  // Only the master's selector lists the examiners; the others see the stored sensei.
  const examiners = useExaminers(isMaster);
  const update = useUpdateSettings();
  const [saved, setSaved] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const retryFocus = useRetryFocus([settings, examiners], titleRef);
  /** Synchronous lock: `update.isPending` only arrives on the next render (double click). */
  const busy = useRef(false);

  const save = async (input: AcademySettingsInput): Promise<AcademySettings | null> => {
    if (busy.current || update.isPending) return null;
    busy.current = true;
    setSaved(false);
    try {
      const result = await update.mutateAsync(input);
      setSaved(true);
      return result;
    } catch {
      // The error is on `update.error`, shown above the fields.
      return null;
    } finally {
      busy.current = false;
    }
  };

  const closeNotice = () => {
    setSaved(false);
    // The close button went away with the notice.
    window.setTimeout(() => {
      focusIfLost(titleRef.current);
    }, 0);
  };

  // A load error replaces the form only while there is no data yet: a failed background
  // reload (window focus) must not throw away what the user typed.
  let content: ReactNode;
  if (settings.data === undefined && settings.isError) {
    content = (
      <LoadError
        title="Não foi possível carregar os dados da academia"
        error={settings.error}
        retrying={settings.isFetching}
        onRetry={() => void settings.refetch()}
        retryFocus={retryFocus}
      />
    );
  } else if (isMaster && examiners.data === undefined && examiners.isError) {
    content = (
      <LoadError
        title="Não foi possível carregar os examinadores"
        error={examiners.error}
        retrying={examiners.isFetching}
        onRetry={() => void examiners.refetch()}
        retryFocus={retryFocus}
      />
    );
  } else if (settings.data === undefined || (isMaster && examiners.data === undefined)) {
    content = <LoadingState label="Carregando dados da academia…" />;
  } else {
    content = (
      <Stack gap="md">
        {isFirstUse(settings.data) && (
          <Text>Os dados da academia ainda não foram preenchidos.</Text>
        )}
        <AcademyForm
          settings={settings.data}
          examiners={isMaster ? (examiners.data ?? []) : null}
          isMaster={isMaster}
          labelledBy={DATA_TITLE_ID}
          error={update.error}
          saving={update.isPending}
          onSubmit={save}
          onEdit={() => {
            setSaved(false);
          }}
        />
      </Stack>
    );
  }

  return (
    <Stack gap="md" maw={640}>
      <Title order={1} size="h2" id={TITLE_ID} ref={titleRef} tabIndex={-1}>
        Academia
      </Title>
      <Stack component="section" gap="md" aria-labelledby={DATA_TITLE_ID}>
        <Title order={2} size="h3" id={DATA_TITLE_ID}>
          Dados da academia
        </Title>
        {saved && (
          <Alert
            color="green"
            variant="light"
            role="status"
            icon={<IconCircleCheck aria-hidden />}
            withCloseButton
            closeButtonLabel="Fechar aviso"
            onClose={closeNotice}
          >
            Dados da academia salvos.
          </Alert>
        )}
        {content}
      </Stack>
      <LogosSection />
    </Stack>
  );
}
