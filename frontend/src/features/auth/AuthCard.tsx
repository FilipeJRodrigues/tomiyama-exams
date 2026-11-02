import { Center, Paper, Stack, Text, Title } from '@mantine/core';
import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
  title: string;
  /** Move the focus to the title on mount (a new step of the same screen). */
  focusTitle?: boolean;
  children: ReactNode;
}

/** Centered card shared by the login and sign-up screens. */
export function AuthCard({ title, focusTitle = false, children }: Props) {
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (focusTitle) titleRef.current?.focus();
  }, [focusTitle]);

  return (
    <Center mih="100dvh" p="md" component="main">
      <Paper withBorder shadow="sm" p="xl" w="100%" maw={420}>
        <Stack gap="md">
          <div>
            <Text size="sm" c="dimmed">
              Tomiyama Exams
            </Text>
            <Title order={1} size="h2" ref={titleRef} tabIndex={focusTitle ? -1 : undefined}>
              {title}
            </Title>
          </div>
          {children}
        </Stack>
      </Paper>
    </Center>
  );
}
