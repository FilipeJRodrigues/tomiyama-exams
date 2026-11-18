import { Stack, Text } from '@mantine/core';

import { PageTitle } from '../../app/PageTitle';

export function NotFoundPage() {
  return (
    <Stack gap="sm">
      <PageTitle order={1} size="h2">
        Página não encontrada
      </PageTitle>
      <Text c="dimmed">O endereço não existe ou foi alterado.</Text>
    </Stack>
  );
}
