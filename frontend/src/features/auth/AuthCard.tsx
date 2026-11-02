import { Center, Paper, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';

interface Props {
  title: string;
  children: ReactNode;
}

/** Centered card shared by the login and sign-up screens. */
export function AuthCard({ title, children }: Props) {
  return (
    <Center mih="100dvh" p="md" component="main">
      <Paper withBorder shadow="sm" p="xl" w="100%" maw={420}>
        <Stack gap="md">
          <div>
            <Text size="sm" c="dimmed">
              Tomiyama Exams
            </Text>
            <Title order={1} size="h2">
              {title}
            </Title>
          </div>
          {children}
        </Stack>
      </Paper>
    </Center>
  );
}
