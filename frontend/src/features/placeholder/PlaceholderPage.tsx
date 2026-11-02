import { Stack, Text, Title } from '@mantine/core';

/** Screen not built yet. */
export function PlaceholderPage({ title }: { title: string }) {
  return (
    <Stack gap="sm">
      <Title order={1} size="h2">
        {title}
      </Title>
      <Text c="dimmed">Esta tela ainda está em construção.</Text>
    </Stack>
  );
}

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
