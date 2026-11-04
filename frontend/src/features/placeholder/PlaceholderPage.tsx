import { Stack, Text, Title } from '@mantine/core';

export function NotFoundPage() {
  return (
    <Stack gap="sm">
      <Title order={1} size="h2">
        Página não encontrada
      </Title>
      <Text c="dimmed">O endereço não existe ou foi alterado.</Text>
    </Stack>
  );
}
